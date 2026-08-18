import {
  BENCHMARK_DEFAULTS,
  BENCHMARK_TYPE,
  validateBenchmarkPayload,
} from "../shared/benchmark-contract.mjs";

const [command, ...arguments_] = process.argv.slice(2);
const baseUrl = requiredEnvironment("GPULINK_URL").replace(/\/$/u, "");

try {
  switch (command) {
    case "workers":
      print(await request("GET", "/v1/workers", undefined, "admin"));
      break;
    case "jobs":
      print(await request("GET", "/v1/jobs", undefined, "client"));
      break;
    case "job":
      print(await request("GET", `/v1/jobs/${encodeURIComponent(requiredArgument(arguments_[0], "job id"))}`, undefined, "client"));
      break;
    case "submit-diagnostic": {
      const minVramMiB = arguments_[0] === undefined ? 256 : Number(arguments_[0]);
      if (!Number.isSafeInteger(minVramMiB) || minVramMiB < 1) {
        throw new Error("minimum VRAM must be a positive integer in MiB");
      }
      print(await request("POST", "/v1/jobs", {
        projectId: "gpulink-operations",
        type: "diagnostic.gpu-status",
        priority: 100,
        constraints: {
          gpuCount: 1,
          minVramMiB,
          capabilities: ["diagnostic.gpu-status"],
        },
        payload: {},
        maxAttempts: 2,
      }, "client", { "Idempotency-Key": `diagnostic-${crypto.randomUUID()}` }));
      break;
    }
    case "submit-benchmark": {
      const payload = validateBenchmarkPayload({
        schemaVersion: 1,
        matrixSize: optionalNumber(arguments_[0], BENCHMARK_DEFAULTS.matrixSize),
        warmupIterations: optionalNumber(arguments_[1], BENCHMARK_DEFAULTS.warmupIterations),
        measuredIterations: optionalNumber(arguments_[2], BENCHMARK_DEFAULTS.measuredIterations),
      });
      print(await request("POST", "/v1/jobs", {
        projectId: "gpulink-benchmark",
        type: BENCHMARK_TYPE,
        priority: 100,
        constraints: {
          gpuCount: 1,
          minVramMiB: 4096,
          capabilities: [BENCHMARK_TYPE],
        },
        payload,
        maxAttempts: 2,
      }, "client", { "Idempotency-Key": `benchmark-${crypto.randomUUID()}` }));
      break;
    }
    case "wait":
      print(await waitForJob(requiredArgument(arguments_[0], "job id")));
      break;
    case "drain":
      print(await setDrain(requiredArgument(arguments_[0], "worker id"), true));
      break;
    case "resume":
      print(await setDrain(requiredArgument(arguments_[0], "worker id"), false));
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function setDrain(workerId, drain) {
  return request(
    "POST",
    `/v1/workers/${encodeURIComponent(workerId)}/drain`,
    { drain },
    "admin",
  );
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await request(
      "GET",
      `/v1/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      "client",
    );
    if (["succeeded", "failed", "cancelled"].includes(response.job.status)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function request(method, path, body, scope, extraHeaders = {}) {
  const token = requiredEnvironment(
    scope === "admin" ? "GPULINK_ADMIN_TOKEN" : "GPULINK_CLIENT_TOKEN",
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const content = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(content.error?.message || `GPUlink returned HTTP ${response.status}`);
  }
  return content;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredArgument(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value, fallback) {
  return value === undefined ? fallback : Number(value);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.error(`Usage:
  npm run cli -- workers
  npm run cli -- jobs
  npm run cli -- job <job-id>
  npm run cli -- submit-diagnostic [minimum-vram-mib]
  npm run cli -- submit-benchmark [matrix-size] [warmup-iterations] [measured-iterations]
  npm run cli -- wait <job-id>
  npm run cli -- drain <worker-id>
  npm run cli -- resume <worker-id>`);
}
