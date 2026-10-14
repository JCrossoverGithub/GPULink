import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  WorkerAgent,
} from "../src/worker/agent.mjs";

import {
  createSessionAdapterRegistry,
  probeSessionAdapters,
} from "../src/worker/session-adapters.mjs";

import {
  DATA_PLANE_SUBPROTOCOL,
} from "../src/shared/data-plane-contract.mjs";

const CAPABILITY = "speech.streaming";
const SINGLE = "speech.streaming.single";
const MULTI = "speech.streaming.multitalker";

const TOKENS = {
  client: "phase5d-readiness-client-test-token-123456",
  worker: "phase5d-readiness-worker-test-token-123456",
  admin: "phase5d-readiness-admin-test-token-123456",
};

function manifest(adapterId) {
  return {
    schemaVersion: 2,
    type: CAPABILITY,
    adapterId,
    version: "1.0.0",
    executionMode: "streaming-gateway",
  };
}

const pause = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(20);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

test(
  "probe exceptions fail closed and a recovered probe restores readiness",
  async () => {
    let state = "ready";

    const registry = createSessionAdapterRegistry([{
      manifest: manifest(SINGLE),
      handleSession: async () => {},
      readinessProbe: async () => {
        if (state === "throw") {
          throw new Error("simulated private probe failure");
        }

        return state === "ready";
      },
    }]);

    const ready = await probeSessionAdapters(registry);

    assert.deepEqual(
      ready.capabilities,
      [CAPABILITY],
    );

    assert.equal(
      ready.adapterManifests[0].adapterId,
      SINGLE,
    );

    assert.equal(ready.adapterHealth[0].state, "ready");

    state = "throw";

    const failed = await probeSessionAdapters(registry);

    assert.deepEqual(failed.capabilities, []);
    assert.deepEqual(failed.adapterManifests, []);

    assert.equal(
      failed.adapterHealth[0].state,
      "unavailable",
    );

    assert.equal(
      failed.adapterHealth[0].code,
      "readiness_probe_failed",
    );

    assert.equal(
      JSON.stringify(failed).includes(
        "simulated private probe failure",
      ),
      false,
      "internal probe details must not be advertised",
    );

    state = "ready";

    const recovered = await probeSessionAdapters(registry);

    assert.deepEqual(
      recovered.capabilities,
      [CAPABILITY],
    );

    assert.equal(
      recovered.adapterHealth[0].state,
      "ready",
    );
  },
);

test(
  "heartbeat propagates loss and recovery without interrupting an unrelated adapter",
  { timeout: 20_000 },
  async () => {
    let singleState = "ready";

    const calls = [];
    const aborted = [];
    const submittedIds = [];

    function makeAdapter(adapterId) {
      return {
        manifest: manifest(adapterId),

        readinessProbe: async () => {
          if (adapterId === MULTI) return true;

          if (singleState === "throw") {
            throw new Error("simulated adapter probe crash");
          }

          return singleState === "ready";
        },

        handleSession: async (
          session,
          { signal, gpu, dataPlaneSocket },
        ) => {
          calls.push({
            adapterId,
            sessionId: session.id,
            requestedId: session.requirements?.adapter,
            gpuUuid: gpu?.uuid,
            protocol: dataPlaneSocket.protocol,
          });

          await new Promise((resolve) => {
            const finish = () => {
              aborted.push(session.id);
              resolve();
            };

            if (signal.aborted) {
              finish();
            } else {
              signal.addEventListener(
                "abort",
                finish,
                { once: true },
              );
            }
          });
        },
      };
    }

    const app = createControlPlane({
      host: "127.0.0.1",
      port: 0,
      dataPath: ":memory:",
      tokens: TOKENS,
      dataPlaneSigningKey:
        "phase5d-readiness-local-only-signing-key-123456",
      dataPlaneGrantTtlMs: 15_000,
      heartbeatTimeoutMs: 5_000,
      leaseDurationMs: 5_000,
      schedulerIntervalMs: 20,
      vramSafetyMiB: 512,
    });

    const address = await app.start();

    const agent = new WorkerAgent({
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      token: TOKENS.worker,
      name: "phase5d-readiness-transition",
      version: "test",
      labels: {},
      capabilities: [],
      warmModels: [],
      heartbeatIntervalMs: 50,
      assignmentIntervalMs: 20,
      capabilityProbeIntervalMs: 20,
      fakeGpus: [0, 1].map((index) => ({
        uuid: `GPU-PHASE5D-READY-${index}`,
        index,
        name: `Readiness Fake GPU ${index}`,
        memoryTotalMiB: 24_576,
        memoryUsedMiB: 0,
        utilizationPercent: 0,
        temperatureC: 35,
        powerDrawWatts: 25,
      })),
    }, {
      sessionAdapters: [
        makeAdapter(SINGLE),
        makeAdapter(MULTI),
      ],
      discoverModelInventory: async () => [],
    });

    async function workerState() {
      const workers = await app.database.listWorkers();

      return workers.find(
        (worker) =>
          worker.name === "phase5d-readiness-transition",
      );
    }

    async function waitForHealth(adapterId, state) {
      await waitUntil(async () => {
        const worker = await workerState();

        return worker?.adapterHealth.some(
          (item) =>
            item.adapterId === adapterId &&
            item.state === state,
        );
      }, `${adapterId} health ${state}`);
    }

    async function submitPinned(adapterId, projectId) {
      const response = await app.service.submitSession({
        projectId,
        capability: CAPABILITY,
        requirements: {
          minVramMiB: 1_000,
          capabilities: [CAPABILITY],
          adapter: adapterId,
        },
        recovery: {
          maxInterruptions: 0,
        },
      });

      submittedIds.push(response.session.id);

      return response.session;
    }

    async function waitForHandler(sessionId) {
      await waitUntil(
        () => calls.some((item) => item.sessionId === sessionId),
        `handler for ${sessionId}`,
      );

      return calls.find(
        (item) => item.sessionId === sessionId,
      );
    }

    try {
      await agent.start();

      await waitForHealth(SINGLE, "ready");
      await waitForHealth(MULTI, "ready");

      // Keep the unrelated implementation executing
      // while SINGLE loses readiness.
      const healthy = await submitPinned(
        MULTI,
        "phase5d-healthy-adapter",
      );

      const healthyCall = await waitForHandler(healthy.id);

      assert.equal(healthyCall.adapterId, MULTI);
      assert.equal(healthyCall.requestedId, MULTI);

      assert.equal(
        healthyCall.protocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      singleState = "unavailable";

      await waitForHealth(SINGLE, "unavailable");

      const degradedWorker = await workerState();

      assert.equal(
        degradedWorker.capabilities.includes(CAPABILITY),
        true,
        "healthy implementation must retain the capability",
      );

      assert.equal(
        degradedWorker.adapterManifests.some(
          (item) => item.adapterId === SINGLE,
        ),
        false,
        "unavailable implementation must not be advertised as ready",
      );

      assert.equal(
        degradedWorker.adapterManifests.some(
          (item) => item.adapterId === MULTI,
        ),
        true,
      );

      // The second GPU is free, but the pinned adapter
      // is unavailable. Placement must still fail closed.
      const pending = await submitPinned(
        SINGLE,
        "phase5d-pending-adapter",
      );

      assert.equal(pending.status, "requested");

      await pause(180);

      assert.equal(
        (await app.database.getSession(pending.id)).status,
        "requested",
      );

      assert.equal(
        calls.some((item) => item.sessionId === pending.id),
        false,
      );

      assert.equal(
        aborted.includes(healthy.id),
        false,
        "unrelated healthy session must not be interrupted",
      );

      // A readiness recovery should allow the pending
      // request to run without restarting the worker.
      singleState = "ready";

      await waitForHealth(SINGLE, "ready");

      const resumedCall = await waitForHandler(pending.id);

      assert.equal(resumedCall.adapterId, SINGLE);
      assert.equal(resumedCall.requestedId, SINGLE);

      assert.notEqual(
        resumedCall.gpuUuid,
        healthyCall.gpuUuid,
        "concurrent sessions must occupy distinct GPUs",
      );

      assert.equal(
        aborted.includes(healthy.id),
        false,
      );

      await app.service.closeSession(pending.id);

      await waitUntil(
        () => aborted.includes(pending.id),
        "first recovered session shutdown",
      );

      // A probe exception must also be propagated
      // as unavailable through the real heartbeat.
      singleState = "throw";

      await waitForHealth(SINGLE, "unavailable");

      const failedWorker = await workerState();

      assert.equal(
        failedWorker.adapterHealth.find(
          (item) => item.adapterId === SINGLE,
        )?.code,
        "readiness_probe_failed",
      );

      const pendingAfterError = await submitPinned(
        SINGLE,
        "phase5d-exception-recovery",
      );

      assert.equal(
        pendingAfterError.status,
        "requested",
      );

      await pause(180);

      assert.equal(
        (await app.database.getSession(
          pendingAfterError.id,
        )).status,
        "requested",
      );

      singleState = "ready";

      await waitForHealth(SINGLE, "ready");

      const recoveredCall =
        await waitForHandler(pendingAfterError.id);

      assert.equal(recoveredCall.adapterId, SINGLE);
      assert.equal(recoveredCall.requestedId, SINGLE);

      assert.equal(
        aborted.includes(healthy.id),
        false,
      );

      await app.service.closeSession(
        pendingAfterError.id,
      );

      await waitUntil(
        () => aborted.includes(pendingAfterError.id),
        "second recovered session shutdown",
      );

      assert.deepEqual(
        calls.map((item) => item.adapterId),
        [MULTI, SINGLE, SINGLE],
      );

      await app.service.closeSession(healthy.id);

      await waitUntil(
        () => aborted.includes(healthy.id),
        "healthy session shutdown",
      );

    } finally {
      for (const sessionId of submittedIds) {
        try {
          await app.service.closeSession(sessionId);
        } catch {
          // Cleanup may encounter an already closed session.
        }
      }

      try {
        await agent.stop();
      } finally {
        await app.stop();
      }
    }
  },
);
