function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedPositiveInteger(value, fallback, name, maximum) {
  const result = positiveInteger(value, fallback, name);
  if (result > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return result;
}

export function loadWorkerConfig(environment = process.env) {
  const token = environment.GPULINK_WORKER_TOKEN?.trim();
  if (!token || token.length < 32) {
    throw new Error("GPULINK_WORKER_TOKEN must contain at least 32 characters");
  }
  const name = environment.GPULINK_WORKER_NAME?.trim();
  if (!name) throw new Error("GPULINK_WORKER_NAME is required");

  return Object.freeze({
    controlPlaneUrl: new URL(
      environment.GPULINK_CONTROL_PLANE_URL?.trim() || "http://127.0.0.1:8088",
    ).toString().replace(/\/$/u, ""),
    token,
    name,
    version: "0.1.0",
    heartbeatIntervalMs: positiveInteger(
      environment.GPULINK_WORKER_HEARTBEAT_INTERVAL_MS,
      5_000,
      "GPULINK_WORKER_HEARTBEAT_INTERVAL_MS",
    ),
    assignmentIntervalMs: positiveInteger(
      environment.GPULINK_WORKER_ASSIGNMENT_INTERVAL_MS,
      1_000,
      "GPULINK_WORKER_ASSIGNMENT_INTERVAL_MS",
    ),
    capabilityProbeIntervalMs: boundedPositiveInteger(
      environment.GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS,
      300_000,
      "GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS",
      3_600_000,
    ),
    capabilities: [...new Set(
      (environment.GPULINK_WORKER_CAPABILITIES?.trim() || "diagnostic.echo,diagnostic.gpu-status")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )].sort(),
    labels: parseObject(environment.GPULINK_WORKER_LABELS_JSON, "GPULINK_WORKER_LABELS_JSON", {}),
    warmModels: parseArray(environment.GPULINK_WORKER_WARM_MODELS_JSON, "GPULINK_WORKER_WARM_MODELS_JSON", []),
    fakeGpus: parseArray(environment.GPULINK_WORKER_FAKE_GPU_JSON, "GPULINK_WORKER_FAKE_GPU_JSON", null),
    benchmark: Object.freeze({
      pythonPath: absolutePath(
        environment.GPULINK_BENCHMARK_PYTHON,
        "GPULINK_BENCHMARK_PYTHON",
        "/opt/gpulink/runtime/benchmark/bin/python",
      ),
      timeoutMs: boundedPositiveInteger(
        environment.GPULINK_BENCHMARK_TIMEOUT_MS,
        60_000,
        "GPULINK_BENCHMARK_TIMEOUT_MS",
        120_000,
      ),
    }),
  });
}

function absolutePath(value, name, fallback) {
  const result = value?.trim() || fallback;
  if (!result.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return result;
}

function parseObject(value, name, fallback) {
  if (!value) return fallback;
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed;
}

function parseArray(value, name, fallback) {
  if (!value) return fallback;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${name} must contain a JSON array`);
  return parsed;
}
