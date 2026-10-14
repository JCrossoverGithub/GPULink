import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  WorkerAgent,
} from "../src/worker/agent.mjs";

const CAPABILITY = "speech.streaming";
const ADAPTER_ID = "speech.streaming.multitalker";

const TOKENS = {
  client: "phase5d-client-test-token-long-enough-123",
  worker: "phase5d-worker-test-token-long-enough-123",
  admin: "phase5d-admin-test-token-long-enough-123",
};

function v2Resolver() {
  return async (_capabilities, _context, checkedAt) => ({
    capabilities: [CAPABILITY],
    adapterManifests: [{
      schemaVersion: 2,
      type: CAPABILITY,
      adapterId: ADAPTER_ID,
      version: "1.0.0",
      executionMode: "streaming-gateway",
    }],
    adapterHealth: [{
      schemaVersion: 2,
      type: CAPABILITY,
      adapterId: ADAPTER_ID,
      state: "ready",
      code: "ready",
      checkedAt,
    }],
  });
}

async function startAndInspect({
  name,
  capabilities,
  options = {},
}) {
  const app = createControlPlane({
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens: TOKENS,
    heartbeatTimeoutMs: 5_000,
    leaseDurationMs: 2_000,
    schedulerIntervalMs: 20,
    vramSafetyMiB: 512,
  });

  const address = await app.start();

  const agent = new WorkerAgent({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    token: TOKENS.worker,
    name,
    version: "test",
    heartbeatIntervalMs: 1_000,
    assignmentIntervalMs: 1_000,
    capabilities,
    labels: {},
    warmModels: [],
    fakeGpus: [{
      uuid: `GPU-${name}`,
      index: 0,
      name: "Phase 5D Fake GPU",
      memoryTotalMiB: 24_576,
      memoryUsedMiB: 0,
      utilizationPercent: 0,
      temperatureC: 35,
      powerDrawWatts: 25,
    }],
  }, {
    discoverModelInventory: async () => [],
    ...options,
  });

  try {
    await agent.start();

    const workers = await app.database.listWorkers();

    assert.equal(workers.length, 1);

    return workers[0];
  } finally {
    try {
      await agent.stop();
    } finally {
      await app.stop();
    }
  }
}

function assertNoExecutableV2Adapter(worker) {
  assert.equal(
    worker.adapterManifests.some(
      (entry) => entry.adapterId === ADAPTER_ID,
    ),
    false,
    "unbound v2 adapter must not be advertised",
  );

  assert.equal(
    worker.adapterHealth.some(
      (entry) =>
        entry.adapterId === ADAPTER_ID &&
        entry.state === "ready",
    ),
    false,
    "unbound v2 adapter must not claim readiness",
  );

  assert.equal(
    worker.capabilities.includes(CAPABILITY),
    false,
    "unbacked session capability must not be advertised",
  );
}

test(
  "worker without handler cannot certify a v2 session adapter",
  async () => {
    const worker = await startAndInspect({
      name: "phase5d-no-handler",
      capabilities: [CAPABILITY],
      options: {
        resolveAdapterHealth: v2Resolver(),
      },
    });

    assertNoExecutableV2Adapter(worker);
  },
);

test(
  "generic handler cannot certify an unbound v2 adapter",
  async () => {
    const worker = await startAndInspect({
      name: "phase5d-generic-handler",
      capabilities: [CAPABILITY],
      options: {
        resolveAdapterHealth: v2Resolver(),
        sessionLeaseHandler: async () => {},
      },
    });

    assertNoExecutableV2Adapter(worker);
  },
);

test(
  "legacy job adapter remains ready without a session handler",
  async () => {
    const worker = await startAndInspect({
      name: "phase5d-legacy-job",
      capabilities: ["diagnostic.echo"],
    });

    assert.deepEqual(worker.capabilities, [
      "diagnostic.echo",
    ]);

    assert.equal(
      worker.adapterManifests.some(
        (entry) =>
          entry.schemaVersion === 1 &&
          entry.type === "diagnostic.echo",
      ),
      true,
    );

    assert.equal(
      worker.adapterHealth.some(
        (entry) =>
          entry.schemaVersion === 1 &&
          entry.type === "diagnostic.echo" &&
          entry.state === "ready",
      ),
      true,
    );
  },
);


function installedSessionAdapter({ ready = true } = {}) {
  return {
    manifest: {
      schemaVersion: 2,
      type: CAPABILITY,
      adapterId: ADAPTER_ID,
      version: "1.0.0",
      executionMode: "streaming-gateway",
    },
    handleSession: async () => {},
    readinessProbe: async () => ready,
  };
}

function constructWithSessionAdapters(sessionAdapters) {
  return new WorkerAgent({
    controlPlaneUrl: "http://127.0.0.1:8088",
    token: TOKENS.worker,
    name: "phase5d-constructor-check",
    version: "test",
    capabilities: [],
    labels: {},
    warmModels: [],
  }, {
    sessionAdapters,
  });
}

test(
  "ready installed session adapter is advertised",
  async () => {
    const worker = await startAndInspect({
      name: "phase5d-ready-binding",
      capabilities: [],
      options: {
        sessionAdapters: [
          installedSessionAdapter(),
        ],
      },
    });

    assert.equal(
      worker.capabilities.includes(CAPABILITY),
      true,
    );

    assert.deepEqual(
      worker.adapterManifests.find(
        (entry) => entry.adapterId === ADAPTER_ID,
      ),
      installedSessionAdapter().manifest,
    );

    assert.equal(
      worker.adapterHealth.find(
        (entry) => entry.adapterId === ADAPTER_ID,
      )?.state,
      "ready",
    );
  },
);

test(
  "unavailable installed session adapter cannot advertise readiness",
  async () => {
    const worker = await startAndInspect({
      name: "phase5d-unready-binding",
      capabilities: [],
      options: {
        sessionAdapters: [
          installedSessionAdapter({ ready: false }),
        ],
      },
    });

    assert.equal(
      worker.capabilities.includes(CAPABILITY),
      false,
    );

    assert.equal(
      worker.adapterManifests.some(
        (entry) => entry.adapterId === ADAPTER_ID,
      ),
      false,
    );

    assert.equal(
      worker.adapterHealth.find(
        (entry) => entry.adapterId === ADAPTER_ID,
      )?.state,
      "unavailable",
    );
  },
);

test(
  "duplicate session adapter identities are rejected",
  () => {
    const first = installedSessionAdapter();

    assert.throws(
      () => constructWithSessionAdapters([
        first,
        { ...first },
      ]),
      /duplicate.*adapter|adapter.*duplicate/iu,
    );
  },
);

test(
  "session adapter without handler is rejected",
  () => {
    const adapter = installedSessionAdapter();
    delete adapter.handleSession;

    assert.throws(
      () => constructWithSessionAdapters([
        adapter,
      ]),
      /handler|handleSession/iu,
    );
  },
);
