import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionAdapterRegistry,
  probeSessionAdapters,
} from "../src/worker/session-adapters.mjs";

const TYPE = "speech.streaming";

function adapter(adapterId, readinessProbe) {
  return {
    manifest: {
      schemaVersion: 2,
      type: TYPE,
      adapterId,
      version: "1.0.0",
      executionMode: "streaming-gateway",
    },
    handleSession: async () => {},
    readinessProbe,
  };
}

const pause = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function inspect(adapters, timeoutMs = 35) {
  const registry = createSessionAdapterRegistry(adapters);

  // The outer deadline prevents this test suite from
  // hanging even before timeout support is implemented.
  let guard;

  try {
    return await Promise.race([
      probeSessionAdapters(
        registry,
        {},
        Date.now(),
        { timeoutMs },
      ),
      new Promise((_, reject) => {
        guard = setTimeout(
          () => reject(
            new Error("PROBE_TIMEOUT_NOT_ENFORCED"),
          ),
          300,
        );
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
}

test(
  "ready adapter retains its existing manifest and capability",
  async () => {
    const report = await inspect([
      adapter("speech.streaming.ready", async () => true),
    ]);

    assert.deepEqual(report.capabilities, [TYPE]);

    assert.equal(report.adapterManifests.length, 1);

    assert.equal(report.adapterHealth.length, 1);
    assert.equal(report.adapterHealth[0].state, "ready");
    assert.equal(report.adapterHealth[0].code, "ready");
  },
);

test(
  "probe exception fails closed without leaking details",
  async () => {
    const report = await inspect([
      adapter("speech.streaming.throws", async () => {
        throw new Error("sensitive-internal-probe-detail");
      }),
    ]);

    assert.deepEqual(report.capabilities, []);
    assert.deepEqual(report.adapterManifests, []);

    assert.equal(
      report.adapterHealth[0].state,
      "unavailable",
    );

    assert.equal(
      report.adapterHealth[0].code,
      "readiness_probe_failed",
    );

    assert.equal(
      JSON.stringify(report).includes(
        "sensitive-internal-probe-detail",
      ),
      false,
    );
  },
);

test(
  "never-resolving readiness probe must return unavailable",
  async () => {
    const report = await inspect([
      adapter(
        "speech.streaming.hung",
        async () => new Promise(() => {}),
      ),
    ]);

    assert.deepEqual(report.capabilities, []);
    assert.deepEqual(report.adapterManifests, []);

    assert.equal(report.adapterHealth.length, 1);

    assert.equal(
      report.adapterHealth[0].state,
      "unavailable",
    );

    assert.equal(
      report.adapterHealth[0].code,
      "readiness_probe_failed",
    );
  },
);

test(
  "hung adapter must not block another ready implementation",
  async () => {
    const hung = "speech.streaming.a-hung";
    const healthy = "speech.streaming.z-healthy";

    const report = await inspect([
      adapter(hung, async () => new Promise(() => {})),
      adapter(healthy, async () => true),
    ]);

    const byId = new Map(
      report.adapterHealth.map((item) => [
        item.adapterId,
        item,
      ]),
    );

    assert.equal(byId.get(hung)?.state, "unavailable");
    assert.equal(byId.get(healthy)?.state, "ready");

    assert.deepEqual(report.capabilities, [TYPE]);

    assert.deepEqual(
      report.adapterManifests.map(
        (manifest) => manifest.adapterId,
      ),
      [healthy],
    );
  },
);

test(
  "late successful probe cannot certify readiness after its deadline",
  async () => {
    const report = await inspect([
      adapter("speech.streaming.late", async () => {
        await pause(130);
        return true;
      }),
    ], 30);

    assert.deepEqual(report.capabilities, []);
    assert.deepEqual(report.adapterManifests, []);

    assert.equal(
      report.adapterHealth[0].state,
      "unavailable",
    );

    // A late probe result must not mutate an already
    // completed health report.
    await pause(150);

    assert.equal(
      report.adapterHealth[0].state,
      "unavailable",
    );
  },
);
