import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_DEFAULTS,
  validateBenchmarkPayload,
} from "../src/shared/benchmark-contract.mjs";
import { resolveAvailableCapabilities } from "../src/worker/adapters.mjs";
import {
  parseBenchmarkResult,
  runGpuBenchmark,
} from "../src/worker/gpu-benchmark.mjs";
import { createTestContext } from "./helpers.mjs";

const gpu = {
  uuid: "GPU-BENCHMARK",
  name: "Benchmark Test GPU",
};
const payload = {
  schemaVersion: 1,
  matrixSize: 4096,
  warmupIterations: 3,
  measuredIterations: 10,
};

test("normalizes benchmark defaults and accepts bounded values", () => {
  assert.deepEqual(validateBenchmarkPayload({}), BENCHMARK_DEFAULTS);
  assert.deepEqual(validateBenchmarkPayload({
    schemaVersion: 1,
    matrixSize: 8192,
    warmupIterations: 10,
    measuredIterations: 25,
  }), {
    schemaVersion: 1,
    matrixSize: 8192,
    warmupIterations: 10,
    measuredIterations: 25,
  });
});

test("rejects unsupported benchmark values and unexpected fields", () => {
  assert.throws(
    () => validateBenchmarkPayload({ matrixSize: 3000 }),
    /must be one of 1024, 2048, 4096, 8192/u,
  );
  assert.throws(
    () => validateBenchmarkPayload({ measuredIterations: 26 }),
    /between 1 and 25/u,
  );
  assert.throws(
    () => validateBenchmarkPayload({ command: "nvidia-smi" }),
    /unexpected field command/u,
  );
});

test("control plane normalizes benchmark payloads before persistence", () => {
  const context = createTestContext();
  try {
    const submitted = context.service.submitJob({
      projectId: "benchmark-test",
      type: "benchmark.gpu",
      constraints: { minVramMiB: 4096 },
      payload: {},
    }).job;
    assert.deepEqual(submitted.payload, BENCHMARK_DEFAULTS);

    assert.throws(
      () => context.service.submitJob({
        projectId: "benchmark-test",
        type: "benchmark.gpu",
        payload: { module: "subprocess" },
      }),
      /unexpected field module/u,
    );
  } finally {
    context.close();
  }
});

test("advertises benchmark capability only after a healthy runtime probe", async () => {
  const capabilities = ["benchmark.gpu", "diagnostic.echo", "not.installed"];
  const fileAccess = async () => {};
  const ready = await resolveAvailableCapabilities(capabilities, {
    benchmark: { pythonPath: "/fixed/python", timeoutMs: 60_000 },
    gpus: [gpu],
    fileAccess,
    runProcess: async () => ({
      stdout: JSON.stringify({
        schemaVersion: 1,
        status: "ok",
        backend: "pytorch-cuda",
        backendVersion: "2.12.1+cu130",
        cudaRuntimeVersion: "13.0",
        deviceCount: 1,
      }),
      stderr: "",
    }),
  });
  assert.deepEqual(ready, ["benchmark.gpu", "diagnostic.echo"]);

  const unavailable = await resolveAvailableCapabilities(capabilities, {
    benchmark: { pythonPath: "/missing/python", timeoutMs: 60_000 },
    gpus: [gpu],
    fileAccess: async () => { throw new Error("missing"); },
  });
  assert.deepEqual(unavailable, ["diagnostic.echo"]);
});

test("runs the fixed benchmark command and returns a bounded structured result", async () => {
  let invocation;
  const result = await runGpuBenchmark({
    assignedGpuUuid: gpu.uuid,
    payload,
  }, {
    gpu,
    benchmark: { pythonPath: "/fixed/python", timeoutMs: 60_000 },
    fileAccess: async () => {},
    runProcess: async (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return { stdout: JSON.stringify(runnerResult()), stderr: "" };
    },
    now: sequenceClock(1_000, 1_250),
  });

  assert.equal(invocation.command, "/fixed/python");
  assert.deepEqual(invocation.arguments_.slice(1), [
    "--matrix-size", "4096",
    "--warmup-iterations", "3",
    "--measured-iterations", "10",
  ]);
  assert.equal(invocation.options.env.CUDA_VISIBLE_DEVICES, gpu.uuid);
  assert.equal("GPULINK_WORKER_TOKEN" in invocation.options.env, false);
  assert.deepEqual(result.gpu, gpu);
  assert.equal(result.durationMs, 250);
  assert.equal(result.estimatedTflops, 17.25);
});

test("rejects malformed, mismatched, and oversized runner results", () => {
  const context = { payload, gpu, startedAt: 1_000, completedAt: 1_500 };
  assert.throws(
    () => parseBenchmarkResult("not-json", context),
    (error) => error.code === "benchmark_result_invalid",
  );
  assert.throws(
    () => parseBenchmarkResult(JSON.stringify(runnerResult({ matrixSize: 2048 })), context),
    (error) => error.code === "benchmark_result_invalid",
  );
  assert.throws(
    () => parseBenchmarkResult(JSON.stringify(runnerResult({ extra: true })), context),
    (error) => error.code === "benchmark_result_invalid",
  );
  assert.throws(
    () => parseBenchmarkResult("x".repeat(65_537), context),
    (error) => error.code === "benchmark_result_invalid",
  );
});

test("preserves benchmark error codes across the shared process boundary", async () => {
  for (const [processCode, benchmarkCode] of [
    ["process_timeout", "benchmark_timeout"],
    ["process_output_limit", "benchmark_output_limit"],
    ["process_runner_failed", "benchmark_runner_failed"],
    ["job_aborted", "job_aborted"],
  ]) {
    await assert.rejects(
      runGpuBenchmark({ assignedGpuUuid: gpu.uuid, payload }, {
        gpu,
        benchmark: { pythonPath: "/fixed/python", timeoutMs: 60_000 },
        fileAccess: async () => {},
        runProcess: async () => {
          const error = new Error("process failed");
          error.code = processCode;
          throw error;
        },
      }),
      (error) => error.code === benchmarkCode,
    );
  }
});

function runnerResult(overrides = {}) {
  return {
    schemaVersion: 1,
    backend: "pytorch-cuda",
    backendVersion: "2.12.1+cu130",
    cudaRuntimeVersion: "13.0",
    matrixSize: payload.matrixSize,
    dtype: "float32",
    warmupIterations: payload.warmupIterations,
    measuredIterations: payload.measuredIterations,
    medianIterationMs: 8.1,
    p95IterationMs: 8.9,
    estimatedTflops: 17.25,
    peakAllocatedMiB: 192,
    ...overrides,
  };
}

function sequenceClock(...values) {
  let index = 0;
  return () => values[index++];
}
