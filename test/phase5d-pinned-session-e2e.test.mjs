import assert from "node:assert/strict";
import test from "node:test";

import { WebSocket } from "ws";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  createDataPlaneProtocols,
  DATA_PLANE_PATH,
  DATA_PLANE_SUBPROTOCOL,
} from "../src/shared/data-plane-contract.mjs";

import {
  WorkerAgent,
} from "../src/worker/agent.mjs";

const CAPABILITY = "speech.streaming";

const MULTI = "speech.streaming.multitalker";
const SINGLE = "speech.streaming.single";

const TOKENS = {
  client: "phase5d-e2e-client-test-token-long-enough-123",
  worker: "phase5d-e2e-worker-test-token-long-enough-123",
  admin: "phase5d-e2e-admin-test-token-long-enough-123",
};

const pause = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(20);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

test(
  "pinned streaming session reaches only its exact adapter over authenticated WebSocket",
  { timeout: 15_000 },
  async () => {
    const app = createControlPlane({
      host: "127.0.0.1",
      port: 0,
      dataPath: ":memory:",
      tokens: TOKENS,
      dataPlaneSigningKey:
        "phase5d-e2e-local-only-test-signing-key-long-enough",
      dataPlaneGrantTtlMs: 15_000,
      heartbeatTimeoutMs: 5_000,
      leaseDurationMs: 5_000,
      schedulerIntervalMs: 20,
      vramSafetyMiB: 512,
    });

    const address = await app.start();

    const invoked = [];
    const aborted = [];

    let clientSocket = null;
    let submitted = null;

    function makeAdapter(adapterId) {
      return {
        manifest: {
          schemaVersion: 2,
          type: CAPABILITY,
          adapterId,
          version: "1.0.0",
          executionMode: "streaming-gateway",
        },

        readinessProbe: async () => true,

        handleSession: async (
          session,
          { signal, dataPlaneSocket },
        ) => {
          invoked.push({
            adapterId,
            sessionId: session.id,
            requestedAdapter:
              session.requirements?.adapter ?? null,
            protocol: dataPlaneSocket.protocol,
          });

          dataPlaneSocket.on(
            "message",
            (data, isBinary) => {
              if (dataPlaneSocket.readyState === WebSocket.OPEN) {
                dataPlaneSocket.send(data, {
                  binary: isBinary,
                });
              }
            },
          );

          await new Promise((resolve) => {
            if (signal.aborted) {
              aborted.push(adapterId);
              resolve();
              return;
            }

            signal.addEventListener(
              "abort",
              () => {
                aborted.push(adapterId);
                resolve();
              },
              { once: true },
            );
          });
        },
      };
    }

    const agent = new WorkerAgent({
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      token: TOKENS.worker,
      name: "phase5d-pinned-session-e2e",
      version: "test",
      heartbeatIntervalMs: 100,
      assignmentIntervalMs: 20,
      capabilityProbeIntervalMs: 100,
      capabilities: [],
      labels: {},
      warmModels: [],
      fakeGpus: [{
        uuid: "GPU-PHASE5D-PINNED-E2E",
        index: 0,
        name: "Phase 5D Fake GPU",
        memoryTotalMiB: 24_576,
        memoryUsedMiB: 0,
        utilizationPercent: 0,
        temperatureC: 35,
        powerDrawWatts: 25,
      }],
    }, {
      sessionAdapters: [
        makeAdapter(MULTI),
        makeAdapter(SINGLE),
      ],
      discoverModelInventory: async () => [],
    });

    try {
      await agent.start();

      const workers = await app.database.listWorkers();

      assert.equal(workers.length, 1);

      assert.deepEqual(
        new Set(
          workers[0].adapterManifests.map(
            (manifest) => manifest.adapterId,
          ),
        ),
        new Set([MULTI, SINGLE]),
      );

      assert.deepEqual(
        new Set(
          workers[0].adapterHealth
            .filter((entry) => entry.state === "ready")
            .map((entry) => entry.adapterId),
        ),
        new Set([MULTI, SINGLE]),
      );

      submitted = (
        await app.service.submitSession({
          projectId: "phase5d-pinned-e2e",
          capability: CAPABILITY,
          requirements: {
            minVramMiB: 1_000,
            capabilities: [CAPABILITY],
            adapter: SINGLE,
          },
          recovery: {
            maxInterruptions: 0,
          },
        })
      ).session;

      assert.equal(submitted.requirements.adapter, SINGLE);

      const stored = await app.database.getSession(
        submitted.id,
      );

      assert.equal(
        stored.requirements.adapter,
        SINGLE,
        "persisted session must retain the adapter pin",
      );

      // EXPECTED RED until positive v2 scheduling is implemented.
      assert.equal(
        submitted.status,
        "allocated",
        "ready pinned v2 session should be allocated",
      );

      await waitUntil(
        () => invoked.length > 0,
        "pinned adapter handler",
      );

      assert.equal(invoked.length, 1);
      assert.equal(invoked[0].adapterId, SINGLE);
      assert.equal(invoked[0].sessionId, submitted.id);
      assert.equal(invoked[0].requestedAdapter, SINGLE);

      assert.equal(
        invoked[0].protocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      const clientGrant =
        await app.service.issueDataPlaneGrant(
          submitted.id,
          "client",
        );

      clientSocket = new WebSocket(
        `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
        createDataPlaneProtocols(clientGrant.token),
        { perMessageDeflate: false },
      );

      await new Promise((resolve, reject) => {
        clientSocket.once("open", resolve);
        clientSocket.once("error", reject);
      });

      await waitUntil(
        async () =>
          (await app.database.getSession(submitted.id))
            .status === "active",
        "active data-plane session",
      );

      const payload = Buffer.from([
        0x01, 0x02, 0x7f, 0x80, 0xff,
      ]);

      const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("frame echo timed out")),
          2_000,
        );

        clientSocket.once("message", (data, isBinary) => {
          clearTimeout(timeout);
          resolve({
            data: Buffer.from(data),
            isBinary,
          });
        });
      });

      clientSocket.send(payload, { binary: true });

      const echoed = await received;

      assert.equal(echoed.isBinary, true);
      assert.deepEqual(echoed.data, payload);

      assert.deepEqual(
        invoked.map((entry) => entry.adapterId),
        [SINGLE],
        "unrequested adapter must never execute",
      );

      await app.service.closeSession(submitted.id);

      await waitUntil(
        () => aborted.includes(SINGLE),
        "pinned handler shutdown",
      );

      assert.equal(aborted.includes(MULTI), false);

    } finally {
      if (submitted?.id) {
        try {
          await app.service.closeSession(submitted.id);
        } catch {
          // A failed test may leave the session already closed.
        }
      }

      clientSocket?.terminate();

      try {
        await agent.stop();
      } finally {
        await app.stop();
      }
    }
  },
);
