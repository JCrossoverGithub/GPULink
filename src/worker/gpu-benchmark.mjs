import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateBenchmarkPayload } from "../shared/benchmark-contract.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";

const benchmarkScriptPath = fileURLToPath(new URL("./runners/gpu-benchmark.py", import.meta.url));
const maximumOutputBytes = 65_536;
const expectedRunnerFields = Object.freeze([
  "schemaVersion",
  "backend",
  "backendVersion",
  "cudaRuntimeVersion",
  "matrixSize",
  "dtype",
  "warmupIterations",
  "measuredIterations",
  "medianIterationMs",
  "p95IterationMs",
  "estimatedTflops",
  "peakAllocatedMiB",
]);

export async function probeBenchmarkRuntime({
  benchmark,
  gpu,
  runProcess = runBoundedProcess,
  fileAccess = access,
} = {}) {
  if (!benchmark || !gpu?.uuid) return false;
  try {
    await fileAccess(benchmark.pythonPath, fsConstants.X_OK);
    await fileAccess(benchmarkScriptPath, fsConstants.R_OK);
    const { stdout } = await runProcess(
      benchmark.pythonPath,
      [benchmarkScriptPath, "--health"],
      {
        timeoutMs: Math.min(benchmark.timeoutMs, 30_000),
        env: benchmarkEnvironment(gpu.uuid),
      },
    );
    const result = parseSingleJsonObject(stdout, "benchmark health probe");
    return result.schemaVersion === 1
      && result.status === "ok"
      && result.backend === "pytorch-cuda"
      && typeof result.backendVersion === "string"
      && typeof result.cudaRuntimeVersion === "string"
      && result.deviceCount === 1;
  } catch {
    return false;
  }
}

export async function runGpuBenchmark(job, {
  signal,
  gpu,
  benchmark,
  runProcess = runBoundedProcess,
  fileAccess = access,
  now = () => Date.now(),
} = {}) {
  let payload;
  try {
    payload = validateBenchmarkPayload(job.payload);
  } catch (error) {
    error.code = "benchmark_payload_invalid";
    throw error;
  }
  if (!gpu || gpu.uuid !== job.assignedGpuUuid) {
    throw benchmarkError(
      "benchmark_gpu_assignment_invalid",
      "Assigned GPU inventory is unavailable",
    );
  }
  if (!benchmark) {
    throw benchmarkError("benchmark_runtime_unavailable", "Benchmark runtime is not configured");
  }

  try {
    await fileAccess(benchmark.pythonPath, fsConstants.X_OK);
    await fileAccess(benchmarkScriptPath, fsConstants.R_OK);
  } catch {
    throw benchmarkError("benchmark_runtime_unavailable", "Benchmark runtime is not installed");
  }

  const startedAt = now();
  let processResult;
  try {
    processResult = await runProcess(
      benchmark.pythonPath,
      [
        benchmarkScriptPath,
        "--matrix-size",
        String(payload.matrixSize),
        "--warmup-iterations",
        String(payload.warmupIterations),
        "--measured-iterations",
        String(payload.measuredIterations),
      ],
      {
        signal,
        timeoutMs: benchmark.timeoutMs,
        env: benchmarkEnvironment(gpu.uuid),
      },
    );
  } catch (error) {
    normalizeProcessError(error);
    throw error;
  }
  const completedAt = now();

  return parseBenchmarkResult(processResult.stdout, {
    payload,
    gpu,
    startedAt,
    completedAt,
  });
}

export function parseBenchmarkResult(stdout, { payload, gpu, startedAt, completedAt }) {
  try {
    const result = parseSingleJsonObject(stdout, "benchmark result");
    const unknown = Object.keys(result).filter((field) => !expectedRunnerFields.includes(field));
    const missing = expectedRunnerFields.filter((field) => !(field in result));
    if (unknown.length > 0 || missing.length > 0) {
      throw new Error("benchmark runner returned an unexpected result schema");
    }
    if (result.schemaVersion !== 1
      || result.backend !== "pytorch-cuda"
      || result.dtype !== "float32"
      || result.matrixSize !== payload.matrixSize
      || result.warmupIterations !== payload.warmupIterations
      || result.measuredIterations !== payload.measuredIterations) {
      throw new Error("benchmark runner result does not match the requested workload");
    }
    requireBoundedString(result.backendVersion, "backendVersion", 100);
    requireBoundedString(result.cudaRuntimeVersion, "cudaRuntimeVersion", 100);
    requireFiniteNumber(result.medianIterationMs, "medianIterationMs", { minimum: 0.000_001 });
    requireFiniteNumber(result.p95IterationMs, "p95IterationMs", {
      minimum: result.medianIterationMs,
    });
    requireFiniteNumber(result.estimatedTflops, "estimatedTflops", { minimum: 0.000_001 });
    requireFiniteNumber(result.peakAllocatedMiB, "peakAllocatedMiB", { minimum: 0 });
    if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt) || completedAt < startedAt) {
      throw new Error("benchmark timestamps are invalid");
    }

    return {
      schemaVersion: 1,
      backend: result.backend,
      backendVersion: result.backendVersion,
      cudaRuntimeVersion: result.cudaRuntimeVersion,
      gpu: { uuid: gpu.uuid, name: gpu.name },
      matrixSize: result.matrixSize,
      dtype: result.dtype,
      warmupIterations: result.warmupIterations,
      measuredIterations: result.measuredIterations,
      medianIterationMs: result.medianIterationMs,
      p95IterationMs: result.p95IterationMs,
      estimatedTflops: result.estimatedTflops,
      peakAllocatedMiB: result.peakAllocatedMiB,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
  } catch (error) {
    error.code = "benchmark_result_invalid";
    throw error;
  }
}

function benchmarkEnvironment(gpuUuid) {
  return {
    PATH: "/opt/gpulink/runtime:/usr/lib/wsl/lib:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin",
    LD_LIBRARY_PATH: "/usr/lib/wsl/lib",
    HOME: "/var/lib/gpulink",
    XDG_CACHE_HOME: "/var/lib/gpulink/cache",
    CUDA_VISIBLE_DEVICES: gpuUuid,
    PYTHONUNBUFFERED: "1",
  };
}

function parseSingleJsonObject(stdout, name) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > maximumOutputBytes) {
    throw new Error(`${name} output is invalid`);
  }
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0].length === 0) {
    throw new Error(`${name} must contain one JSON object`);
  }
  const result = JSON.parse(lines[0]);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return result;
}

function requireBoundedString(value, name, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`benchmark runner returned invalid ${name}`);
  }
}

function requireFiniteNumber(value, name, { minimum }) {
  if (!Number.isFinite(value) || value < minimum || value > 1_000_000) {
    throw new Error(`benchmark runner returned invalid ${name}`);
  }
}

function benchmarkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeProcessError(error) {
  switch (error.code) {
    case "process_timeout":
      error.code = "benchmark_timeout";
      error.message = "Benchmark runner exceeded its time limit";
      break;
    case "process_output_limit":
      error.code = "benchmark_output_limit";
      error.message = "Benchmark runner exceeded its output limit";
      break;
    case "job_aborted":
      error.message = "Benchmark job was aborted";
      break;
    case "benchmark_timeout":
    case "benchmark_output_limit":
    case "benchmark_runner_failed":
      break;
    default:
      error.code = "benchmark_runner_failed";
  }
}
