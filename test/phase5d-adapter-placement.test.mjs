import assert from "node:assert/strict";
import test from "node:test";

import {
  choosePlacement,
} from "../src/control-plane/scheduler.mjs";

const NOW = Date.now();

const CAPABILITY = "speech.streaming";
const SINGLE = "speech.streaming.single";
const MULTI = "speech.streaming.multitalker";

function manifest(adapterId, type = CAPABILITY) {
  return {
    schemaVersion: 2,
    type,
    adapterId,
    version: "1.0.0",
    executionMode: "streaming-gateway",
  };
}

function health(
  adapterId,
  state = "ready",
  type = CAPABILITY,
) {
  return {
    schemaVersion: 2,
    type,
    adapterId,
    state,
    code:
      state === "ready"
        ? "ready"
        : "readiness_probe_failed",
    checkedAt: NOW,
  };
}

function worker(
  id,
  {
    adapterIds = [SINGLE],
    readyIds = adapterIds,
    utilizationPercent = 5,
  } = {},
) {
  return {
    id,
    name: id,
    status: "online",
    drainMode: false,
    lastSeenAt: NOW,

    capabilities: [CAPABILITY],

    adapterManifests:
      adapterIds.map((adapterId) => manifest(adapterId)),

    adapterHealth:
      readyIds.map((adapterId) => health(adapterId)),

    warmModels: [],
    modelInventory: [],

    gpus: [{
      uuid: `GPU-${id}`,
      memoryTotalMiB: 24_576,
      memoryUsedMiB: 0,
      utilizationPercent,
    }],
  };
}

function placement(
  workers,
  {
    adapterId = SINGLE,
    occupiedGpus = new Set(),
  } = {},
) {
  return choosePlacement(
    {
      requirements: {
        gpuCount: 1,
        minVramMiB: 1_024,
        capabilities: [CAPABILITY],
        model: null,
        adapter: adapterId,
      },
    },
    workers,
    occupiedGpus,
    {
      now: NOW,
      heartbeatTimeoutMs: 5_000,
      vramSafetyMiB: 512,
    },
  );
}

// POSITIVE CONTRACTS: currently expected RED.

test(
  "ready exact v2 adapter can receive pinned placement",
  () => {
    const chosen = placement([
      worker("exact-match"),
    ]);

    assert.ok(
      chosen,
      "ready exact adapter must be eligible",
    );

    assert.equal(
      chosen.workerId,
      "exact-match",
    );

    assert.equal(
      chosen.gpuUuid,
      "GPU-exact-match",
    );
  },
);

test(
  "pinned identity overrides a competing worker with the same capability",
  () => {
    const chosen = placement([
      worker("wrong-adapter", {
        adapterIds: [MULTI],
        utilizationPercent: 0,
      }),
      worker("correct-adapter", {
        adapterIds: [SINGLE],
        utilizationPercent: 60,
      }),
    ]);

    assert.ok(
      chosen,
      "exact matching worker must be selected",
    );

    assert.equal(
      chosen.workerId,
      "correct-adapter",
    );
  },
);

test(
  "worker with multiple ready v2 identities supports either pinned implementation",
  () => {
    const candidate = worker("multi-adapter", {
      adapterIds: [SINGLE, MULTI],
    });

    const chosen = placement(
      [candidate],
      { adapterId: MULTI },
    );

    assert.ok(
      chosen,
      "second ready adapter identity must be eligible",
    );

    assert.equal(
      chosen.workerId,
      "multi-adapter",
    );
  },
);

// NEGATIVE CONTRACTS: must remain fail-closed.

test(
  "different ready adapter ID does not satisfy pin",
  () => {
    assert.equal(
      placement([
        worker("wrong", {
          adapterIds: [MULTI],
        }),
      ]),
      null,
    );
  },
);

test(
  "ready health without a manifest is insufficient",
  () => {
    const candidate = worker("health-only");
    candidate.adapterManifests = [];

    assert.equal(placement([candidate]), null);
  },
);

test(
  "manifest without ready health is insufficient",
  () => {
    const candidate = worker("manifest-only");
    candidate.adapterHealth = [];

    assert.equal(placement([candidate]), null);
  },
);

test(
  "unavailable adapter is never schedulable",
  () => {
    const candidate = worker("unavailable");
    candidate.adapterHealth = [
      health(SINGLE, "unavailable"),
    ];

    assert.equal(placement([candidate]), null);
  },
);

test(
  "manifest and health identities cannot be cross-matched",
  () => {
    const candidate = worker("cross-match", {
      adapterIds: [MULTI],
      readyIds: [SINGLE],
    });

    assert.equal(placement([candidate]), null);
  },
);

test(
  "matching ID with wrong manifest capability is rejected",
  () => {
    const candidate = worker("wrong-type");

    candidate.adapterManifests = [
      manifest(SINGLE, "vision.streaming"),
    ];

    candidate.adapterHealth = [
      health(SINGLE, "ready", "vision.streaming"),
    ];

    assert.equal(placement([candidate]), null);
  },
);

test(
  "legacy v1 capability cannot satisfy a v2 adapter pin",
  () => {
    const candidate = worker("legacy-only");

    candidate.adapterManifests = [{
      schemaVersion: 1,
      type: CAPABILITY,
      version: "1.0.0",
      executionMode: "streaming-gateway",
    }];

    candidate.adapterHealth = [{
      schemaVersion: 1,
      type: CAPABILITY,
      state: "ready",
      code: "ready",
      checkedAt: NOW,
    }];

    assert.equal(placement([candidate]), null);
  },
);

test(
  "occupied GPU remains exclusive for pinned sessions",
  () => {
    const candidate = worker("occupied");

    assert.equal(
      placement(
        [candidate],
        {
          occupiedGpus:
            new Set(["GPU-occupied"]),
        },
      ),
      null,
    );
  },
);

test(
  "stale worker cannot receive pinned placement",
  () => {
    const candidate = worker("stale");

    candidate.lastSeenAt = NOW - 10_000;

    assert.equal(placement([candidate]), null);
  },
);

test(
  "draining worker cannot receive pinned placement",
  () => {
    const candidate = worker("draining");

    candidate.drainMode = true;

    assert.equal(placement([candidate]), null);
  },
);
