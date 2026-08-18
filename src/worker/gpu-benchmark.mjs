import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateBenchmarkPayload } from "../shared/benchmark-contract.mjs";

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
    if (!error.code?.startsWith("benchmark_")) error.code = "benchmark_runner_failed";
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

export function runBoundedProcess(command, arguments_, {
  signal,
  timeoutMs = 60_000,
  env,
  maxOutputBytes = maximumOutputBytes,
} = {}) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, arguments_, {
      detached,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let killTimer = null;

    const terminate = (code, message) => {
      if (failure) return;
      failure = benchmarkError(code, message);
      killChild(child, detached, "SIGTERM");
      killTimer = setTimeout(() => killChild(child, detached, "SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    const collect = (chunks, chunk, stream) => {
      const bytes = stream === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (stream === "stdout") stdoutBytes = bytes;
      else stderrBytes = bytes;
      if (bytes > maxOutputBytes) {
        terminate("benchmark_output_limit", "Benchmark runner exceeded its output limit");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));

    const timeout = setTimeout(
      () => terminate("benchmark_timeout", "Benchmark runner exceeded its time limit"),
      timeoutMs,
    );
    timeout.unref?.();
    const abort = () => terminate("job_aborted", "Benchmark job was aborted");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (!failure) failure = benchmarkError("benchmark_runner_failed", error.message);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (exitCode !== 0) {
        const detail = stderrText.trim().slice(0, 2_000);
        reject(benchmarkError(
          "benchmark_runner_failed",
          detail || `Benchmark runner exited with ${exitSignal || exitCode}`,
        ));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
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

function killChild(child, detached, signal) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function benchmarkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
