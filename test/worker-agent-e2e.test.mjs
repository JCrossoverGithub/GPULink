import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlane } from "../src/control-plane/app.mjs";
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
    assert.deepEqual(app.database.listWorkers()[0].adapterManifests, [{
      schemaVersion: 1,
      type: "diagnostic.echo",
      version: "1.0.0",
      executionMode: "in-process",
    }]);
    assert.deepEqual(
      app.database.listWorkers()[0].adapterHealth.map(({ checkedAt, ...report }) => ({
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
    assert.deepEqual(app.database.listWorkers()[0].modelInventory, [{
      schemaVersion: 1,
      modelId: "nvidia/parakeet-tdt-0.6b-v2",
      revision: "main",
      adapterType: "speech.streaming",
    }]);
    const submitted = app.service.submitJob({
      projectId: "test",
      type: "diagnostic.echo",
      constraints: { minVramMiB: 1000 },
      payload: { echo: "verified", durationMs: 10 },
    }).job;

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
    assert.deepEqual(app.database.listWorkers()[0].adapterManifests, [{
      schemaVersion: 1,
      type: "benchmark.gpu",
      version: "1.0.0",
      executionMode: "bounded-process",
    }]);
    assert.equal(app.database.listWorkers()[0].adapterHealth[0].state, "ready");
    assert.equal(app.database.listWorkers()[0].adapterHealth[0].type, "benchmark.gpu");
    const submitted = app.service.submitJob({
      projectId: "test",
      type: "benchmark.gpu",
      constraints: { minVramMiB: 4096 },
      payload: {
        schemaVersion: 1,
        matrixSize: 1024,
        warmupIterations: 1,
        measuredIterations: 2,
      },
    }).job;

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
    const job = database.getJob(jobId);
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const job = database.getJob(jobId);
  throw new Error(`Timed out waiting for ${jobId} to become ${status}; current state is ${job.status}`);
}
