import assert from "node:assert/strict";
import test from "node:test";

import {
  WebSocket,
} from "ws";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  createDataPlaneProtocols,
  DATA_PLANE_PATH,
  DATA_PLANE_SUBPROTOCOL,
} from "../src/shared/data-plane-contract.mjs";

import { WorkerAgent } from "../src/worker/agent.mjs";

const tokens = {
  client: "worker-e2e-client-token-at-least-32-characters",
  worker: "worker-e2e-worker-token-at-least-32-characters",
  admin: "worker-e2e-admin-token-at-least-32-characters",
};

test("worker agent discovers a GPU and completes an allowlisted diagnostic job", async () => {
  const app = createControlPlane({
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    heartbeatTimeoutMs: 5_000,
    leaseDurationMs: 2_000,
    schedulerIntervalMs: 20,
    vramSafetyMiB: 512,
  });
  const address = await app.start();
  const agent = new WorkerAgent({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    token: tokens.worker,
    name: "agent-e2e-worker",
    version: "test",
    heartbeatIntervalMs: 100,
    assignmentIntervalMs: 20,
    capabilities: ["diagnostic.echo"],
    labels: {},
    warmModels: [],
    fakeGpus: [{
      uuid: "GPU-AGENT-E2E",
      index: 0,
      name: "Agent E2E GPU",
      memoryTotalMiB: 24576,
      memoryUsedMiB: 0,
      utilizationPercent: 0,
      temperatureC: 35,
      powerDrawWatts: 25,
    }],
  }, {
    discoverModelInventory: async () => [{
      schemaVersion: 1,
      modelId: "nvidia/parakeet-tdt-0.6b-v2",
      revision: "main",
      adapterType: "speech.streaming",
    }],
  });

  try {
    await agent.start();
    assert.deepEqual((await app.database.listWorkers())[0].adapterManifests, [{
      schemaVersion: 1,
      type: "diagnostic.echo",
      version: "1.0.0",
      executionMode: "in-process",
    }]);
    assert.deepEqual(
      (await app.database.listWorkers())[0].adapterHealth.map(({ checkedAt, ...report }) => ({
        ...report,
        checkedAtValid: Number.isSafeInteger(checkedAt),
      })),
      [{
        schemaVersion: 1,
        type: "diagnostic.echo",
        state: "ready",
        code: "ready",
        checkedAtValid: true,
      }],
    );
    assert.deepEqual((await app.database.listWorkers())[0].modelInventory, [{
      schemaVersion: 1,
      modelId: "nvidia/parakeet-tdt-0.6b-v2",
      revision: "main",
      adapterType: "speech.streaming",
    }]);
    const submitted = (await app.service.submitJob({
      projectId: "test",
      type: "diagnostic.echo",
      constraints: { minVramMiB: 1000 },
      payload: { echo: "verified", durationMs: 10 },
    })).job;

    const finished = await waitForJob(app.database, submitted.id, "succeeded", 2_000);
    assert.equal(finished.assignedGpuUuid, "GPU-AGENT-E2E");
    assert.equal(finished.result.echo, "verified");
  } finally {
    await agent.stop();
    await app.stop();
  }
});

test("worker agent completes a scheduled benchmark through an injected GPU-free runner", async () => {
  const app = createControlPlane({
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    heartbeatTimeoutMs: 5_000,
    leaseDurationMs: 2_000,
    schedulerIntervalMs: 20,
    vramSafetyMiB: 512,
  });
  const address = await app.start();
  const benchmarkGpu = {
    uuid: "GPU-BENCHMARK-E2E",
    index: 0,
    name: "Benchmark E2E GPU",
    memoryTotalMiB: 8192,
    memoryUsedMiB: 0,
    utilizationPercent: 0,
    temperatureC: 35,
    powerDrawWatts: 25,
  };
  const runProcess = async (_command, arguments_) => {
    if (arguments_.includes("--health")) {
      return { stdout: JSON.stringify({
        schemaVersion: 1,
        status: "ok",
        backend: "pytorch-cuda",
        backendVersion: "test",
        cudaRuntimeVersion: "test",
        deviceCount: 1,
      }), stderr: "" };
    }
    return { stdout: JSON.stringify({
      schemaVersion: 1,
      backend: "pytorch-cuda",
      backendVersion: "test",
      cudaRuntimeVersion: "test",
      matrixSize: 1024,
      dtype: "float32",
      warmupIterations: 1,
      measuredIterations: 2,
      medianIterationMs: 1.5,
      p95IterationMs: 1.7,
      estimatedTflops: 1.4,
      peakAllocatedMiB: 12,
    }), stderr: "" };
  };
  const agent = new WorkerAgent({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    token: tokens.worker,
    name: "benchmark-e2e-worker",
    version: "test",
    heartbeatIntervalMs: 100,
    assignmentIntervalMs: 20,
    capabilityProbeIntervalMs: 60_000,
    capabilities: ["benchmark.gpu"],
    labels: {},
    warmModels: [],
    fakeGpus: [benchmarkGpu],
    benchmark: { pythonPath: "/fixed/python", timeoutMs: 60_000 },
  }, {
    adapterContext: {
      runProcess,
      fileAccess: async () => {},
      now: (() => {
        let now = 1_000;
        return () => (now += 100);
      })(),
    },
  });

  try {
    await agent.start();
    assert.deepEqual((await app.database.listWorkers())[0].adapterManifests, [{
      schemaVersion: 1,
      type: "benchmark.gpu",
      version: "1.0.0",
      executionMode: "bounded-process",
    }]);
    assert.equal((await app.database.listWorkers())[0].adapterHealth[0].state, "ready");
    assert.equal((await app.database.listWorkers())[0].adapterHealth[0].type, "benchmark.gpu");
    const submitted = (await app.service.submitJob({
      projectId: "test",
      type: "benchmark.gpu",
      constraints: { minVramMiB: 4096 },
      payload: {
        schemaVersion: 1,
        matrixSize: 1024,
        warmupIterations: 1,
        measuredIterations: 2,
      },
    })).job;

    const finished = await waitForJob(app.database, submitted.id, "succeeded", 2_000);
    assert.equal(finished.result.backend, "pytorch-cuda");
    assert.equal(finished.result.gpu.uuid, benchmarkGpu.uuid);
    assert.equal(finished.result.matrixSize, 1024);
  } finally {
    await agent.stop();
    await app.stop();
  }
});

async function waitForJob(database, jobId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await database.getJob(jobId);
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const job = await database.getJob(jobId);
  throw new Error(`Timed out waiting for ${jobId} to become ${status}; current state is ${job.status}`);
}

test(
  "worker agent starts and renews an allocated session only with an installed session lease handler",
  async () => {
    const app =
      createControlPlane({
        host: "127.0.0.1",
        port: 0,
        dataPath: ":memory:",
        tokens,
        dataPlaneSigningKey:
          "worker-session-e2e-data-plane-signing-key-at-least-32-characters",
        dataPlaneGrantTtlMs:
          15_000,
        heartbeatTimeoutMs:
          5_000,
        leaseDurationMs:
          5_000,
        schedulerIntervalMs:
          20,
        vramSafetyMiB:
          512,
      });

    const address =
      await app.start();

    let handlerStarted =
      false;

    let handlerAborted =
      false;

    let handlerSocketProtocol =
      null;

    const agent =
      new WorkerAgent(
        {
          controlPlaneUrl:
            `http://127.0.0.1:${address.port}`,
          token:
            tokens.worker,
          name:
            "session-agent-e2e-worker",
          version:
            "test",
          heartbeatIntervalMs:
            100,
          assignmentIntervalMs:
            20,
          capabilities: [
            "diagnostic.echo",
          ],
          labels: {},
          warmModels: [],
          fakeGpus: [
            {
              uuid:
                "GPU-SESSION-AGENT-E2E",
              index: 0,
              name:
                "Session Agent E2E GPU",
              memoryTotalMiB:
                24_576,
              memoryUsedMiB: 0,
              utilizationPercent: 0,
              temperatureC: 35,
              powerDrawWatts: 25,
            },
          ],
        },
        {
          sessionLeaseHandler:
            async (
              _session,
              {
                signal,
                dataPlaneSocket,
              },
            ) => {
              handlerSocketProtocol =
                dataPlaneSocket
                  .protocol;

              handlerStarted =
                true;

              await new Promise(
                (resolve) => {
                  if (
                    signal.aborted
                  ) {
                    handlerAborted =
                      true;

                    resolve();

                    return;
                  }

                  signal
                    .addEventListener(
                      "abort",
                      () => {
                        handlerAborted =
                          true;

                        resolve();
                      },
                      {
                        once: true,
                      },
                    );
                },
              );
            },
        },
      );

    try {
      await agent.start();

      const submitted =
        (
          await app.service
            .submitSession({
              projectId:
                "worker-session-control-e2e",
              capability:
                "diagnostic.echo",
              requirements: {
                minVramMiB:
                  1_000,
                capabilities: [
                  "diagnostic.echo",
                ],
              },
              recovery: {
                maxInterruptions: 0,
              },
            })
        ).session;

      assert.equal(
        submitted.status,
        "allocated",
      );

      const connecting =
        await waitForSession(
          app.database,
          submitted.id,
          "connecting",
          2_000,
        );

      assert.equal(
        connecting
          .assignedGpuUuid,
        "GPU-SESSION-AGENT-E2E",
      );

      await waitFor(
        () =>
          handlerStarted,
        2_000,
        "session lease handler to start",
      );

      assert.equal(
        handlerSocketProtocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      const firstExpiry =
        connecting
          .leaseExpiresAt;

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            800,
          ),
      );

      const renewed =
        await app.database
          .getSession(
            submitted.id,
          );

      assert.equal(
        renewed.status,
        "connecting",
      );

      assert.ok(
        renewed.leaseExpiresAt >
          firstExpiry,
      );

      await app.service
        .closeSession(
          submitted.id,
        );

      await waitFor(
        () =>
          handlerAborted,
        2_000,
        "session lease handler to abort after close",
      );

      const closed =
        await app.database
          .getSession(
            submitted.id,
          );

      assert.equal(
        closed.status,
        "closed",
      );
    } finally {
      await agent.stop();
      await app.stop();
    }
  },
);

test(
  "worker agent obtains a worker grant, joins the relay, and exchanges opaque frames with a client",
  async () => {
    const signingKey =
      "worker-relay-e2e-data-plane-signing-key-at-least-32-characters";

    const app =
      createControlPlane({
        host: "127.0.0.1",
        port: 0,
        dataPath: ":memory:",
        tokens,
        dataPlaneSigningKey:
          signingKey,
        dataPlaneGrantTtlMs:
          15_000,
        heartbeatTimeoutMs:
          5_000,
        leaseDurationMs:
          5_000,
        schedulerIntervalMs:
          20,
        vramSafetyMiB:
          512,
      });

    const address =
      await app.start();

    let clientSocket =
      null;

    let workerHandlerStarted =
      false;

    let workerHandlerAborted =
      false;

    const agent =
      new WorkerAgent(
        {
          controlPlaneUrl:
            `http://127.0.0.1:${address.port}`,
          token:
            tokens.worker,
          name:
            "session-relay-e2e-worker",
          version:
            "test",
          heartbeatIntervalMs:
            100,
          assignmentIntervalMs:
            20,
          capabilities: [
            "diagnostic.echo",
          ],
          labels: {},
          warmModels: [],
          fakeGpus: [
            {
              uuid:
                "GPU-SESSION-RELAY-E2E",
              index: 0,
              name:
                "Session Relay E2E GPU",
              memoryTotalMiB:
                24_576,
              memoryUsedMiB: 0,
              utilizationPercent: 0,
              temperatureC: 35,
              powerDrawWatts: 25,
            },
          ],
        },
        {
          sessionLeaseHandler:
            async (
              _session,
              {
                signal,
                dataPlaneSocket,
              },
            ) => {
              workerHandlerStarted =
                true;

              dataPlaneSocket.on(
                "message",
                (
                  data,
                  isBinary,
                ) => {
                  if (
                    dataPlaneSocket
                      .readyState ===
                    WebSocket.OPEN
                  ) {
                    dataPlaneSocket.send(
                      data,
                      {
                        binary:
                          isBinary,
                      },
                    );
                  }
                },
              );

              await new Promise(
                (resolve) => {
                  if (
                    signal.aborted
                  ) {
                    workerHandlerAborted =
                      true;

                    resolve();
                    return;
                  }

                  signal
                    .addEventListener(
                      "abort",
                      () => {
                        workerHandlerAborted =
                          true;

                        resolve();
                      },
                      {
                        once: true,
                      },
                    );
                },
              );
            },
        },
      );

    try {
      await agent.start();

      const submitted =
        (
          await app.service
            .submitSession({
              projectId:
                "worker-relay-e2e",
              capability:
                "diagnostic.echo",
              requirements: {
                minVramMiB:
                  1_000,
                capabilities: [
                  "diagnostic.echo",
                ],
              },
              recovery: {
                maxInterruptions: 0,
              },
            })
        ).session;

      const connecting =
        await waitForSession(
          app.database,
          submitted.id,
          "connecting",
          2_000,
        );

      await waitFor(
        () =>
          workerHandlerStarted,
        2_000,
        "worker relay handler to start",
      );

      /*
       * The worker side exists, but the session
       * must remain connecting until the client
       * side joins the exact same allocation.
       */
      assert.equal(
        (
          await app.database
            .getSession(
              submitted.id,
            )
        ).status,
        "connecting",
      );

      const clientGrant =
        await app.service
          .issueDataPlaneGrant(
            submitted.id,
            "client",
          );

      clientSocket =
        new WebSocket(
          `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
          createDataPlaneProtocols(
            clientGrant.token,
          ),
          {
            perMessageDeflate:
              false,
          },
        );

      await waitForSocketOpen(
        clientSocket,
      );

      assert.equal(
        clientSocket.protocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      const active =
        await waitForSession(
          app.database,
          submitted.id,
          "active",
          2_000,
        );

      assert.equal(
        active.leaseId,
        connecting.leaseId,
      );

      const received =
        nextSocketMessage(
          clientSocket,
        );

      const payload =
        Buffer.from([
          0x01,
          0x02,
          0x7f,
          0x80,
          0xff,
        ]);

      clientSocket.send(
        payload,
        {
          binary: true,
        },
      );

      const echoed =
        await received;

      assert.equal(
        echoed.isBinary,
        true,
      );

      assert.deepEqual(
        echoed.data,
        payload,
      );

      const events =
        await app.database
          .listEventsAfter(0);

      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.subjectId ===
              submitted.id,
          )
          .map(
            (event) =>
              event.type,
          ),
        [
          "session.requested",
          "session.allocated",
          "session.connecting",
          "session.active",
        ],
      );

      assert.equal(
        JSON.stringify(
          events,
        ).includes(
          payload.toString(
            "hex",
          ),
        ),
        false,
      );

      await app.service
        .closeSession(
          submitted.id,
        );

      await waitFor(
        () =>
          workerHandlerAborted,
        2_000,
        "worker relay handler to abort after session close",
      );
    } finally {
      clientSocket?.terminate();

      await agent.stop();
      await app.stop();
    }
  },
);

test(
  "worker agent leaves allocated sessions untouched when no session lease handler is installed",
  async () => {
    const app =
      createControlPlane({
        host: "127.0.0.1",
        port: 0,
        dataPath: ":memory:",
        tokens,
        heartbeatTimeoutMs:
          5_000,
        leaseDurationMs:
          2_000,
        schedulerIntervalMs:
          20,
        vramSafetyMiB:
          512,
      });

    const address =
      await app.start();

    const agent =
      new WorkerAgent({
        controlPlaneUrl:
          `http://127.0.0.1:${address.port}`,
        token:
          tokens.worker,
        name:
          "session-agent-fail-closed-worker",
        version:
          "test",
        heartbeatIntervalMs:
          100,
        assignmentIntervalMs:
          20,
        capabilities: [
          "diagnostic.echo",
        ],
        labels: {},
        warmModels: [],
        fakeGpus: [
          {
            uuid:
              "GPU-SESSION-FAIL-CLOSED",
            index: 0,
            name:
              "Session Fail Closed GPU",
            memoryTotalMiB:
              24_576,
            memoryUsedMiB: 0,
            utilizationPercent: 0,
            temperatureC: 35,
            powerDrawWatts: 25,
          },
        ],
      });

    try {
      await agent.start();

      const submitted =
        (
          await app.service
            .submitSession({
              projectId:
                "worker-session-fail-closed",
              capability:
                "diagnostic.echo",
              requirements: {
                minVramMiB:
                  1_000,
                capabilities: [
                  "diagnostic.echo",
                ],
              },
              recovery: {
                maxInterruptions: 0,
              },
            })
        ).session;

      assert.equal(
        submitted.status,
        "allocated",
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            200,
          ),
      );

      const stored =
        await app.database
          .getSession(
            submitted.id,
          );

      assert.equal(
        stored.status,
        "allocated",
      );

      const events =
        (
          await app.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            submitted.id,
        );

      assert.deepEqual(
        events.map(
          (event) =>
            event.type,
        ),
        [
          "session.requested",
          "session.allocated",
        ],
      );
    } finally {
      await agent.stop();
      await app.stop();
    }
  },
);


async function waitForSocketOpen(
  socket,
) {
  if (
    socket.readyState ===
    WebSocket.OPEN
  ) {
    return;
  }

  await new Promise(
    (
      resolve,
      reject,
    ) => {
      const onOpen =
        () => {
          cleanup();
          resolve();
        };

      const onError =
        (error) => {
          cleanup();
          reject(
            error,
          );
        };

      const cleanup =
        () => {
          socket.off(
            "open",
            onOpen,
          );

          socket.off(
            "error",
            onError,
          );
        };

      socket.once(
        "open",
        onOpen,
      );

      socket.once(
        "error",
        onError,
      );
    },
  );
}

function nextSocketMessage(
  socket,
) {
  return new Promise(
    (
      resolve,
      reject,
    ) => {
      const onMessage =
        (
          data,
          isBinary,
        ) => {
          cleanup();

          resolve({
            data,
            isBinary,
          });
        };

      const onError =
        (error) => {
          cleanup();
          reject(
            error,
          );
        };

      const cleanup =
        () => {
          socket.off(
            "message",
            onMessage,
          );

          socket.off(
            "error",
            onError,
          );
        };

      socket.once(
        "message",
        onMessage,
      );

      socket.once(
        "error",
        onError,
      );
    },
  );
}

async function waitForSession(
  database,
  sessionId,
  status,
  timeoutMs,
) {
  const deadline =
    Date.now() +
    timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    const session =
      await database
        .getSession(
          sessionId,
        );

    if (
      session?.status ===
      status
    ) {
      return session;
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          10,
        ),
    );
  }

  const session =
    await database
      .getSession(
        sessionId,
      );

  throw new Error(
    `Timed out waiting for ${sessionId} to become ${status}; current state is ${session?.status}`,
  );
}

async function waitFor(
  predicate,
  timeoutMs,
  description,
) {
  const deadline =
    Date.now() +
    timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    if (predicate()) {
      return;
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          10,
        ),
    );
  }

  throw new Error(
    `Timed out waiting for ${description}`,
  );
}
