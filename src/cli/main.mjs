#!/usr/bin/env node
import { runDoctor } from "./doctor.mjs";
import { runLocalInit } from "./local-init.mjs";
import { readLocalSmokeSetup, runLocalSmoke } from "./local-smoke.mjs";
import { runLocalStatus } from "./local-status.mjs";
import { runLocalStart, runLocalStop, runLocalWorkerStart, runLocalWorkerStop } from "./local-lifecycle.mjs";
import { defaultLocalSetupDirectory, parseGlobalCliOptions } from "./setup-directory.mjs";
import { normalizeWorkerControlPlaneUrl } from "../worker/config.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_DEFAULTS,
  BENCHMARK_TYPE,
  validateBenchmarkPayload,
} from "../shared/benchmark-contract.mjs";

try {
  const { args, directory: explicitDirectory } = parseGlobalCliOptions(process.argv.slice(2));
  const [command, ...arguments_] = args;
  const defaultDirectory = defaultLocalSetupDirectory();
  const selectedDirectory = explicitDirectory ??
    (existsSync(defaultDirectory) ? defaultDirectory : null);
  if (command === "--version" || command === "version") {
    const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    console.log(JSON.parse(readFileSync(packageFile, "utf8")).version);
  } else if (command === "--help" || command === "help" || command === "-h") {
    usage(false);
  } else {
    // Only generated localhost installations are selected in this milestone.
    // A remote/production deployment must still supply explicit environment configuration.
    if (selectedDirectory && command !== "init") {
      if (command === "local" && arguments_[0] === "smoke") {
        if (explicitDirectory && arguments_[2]) throw new Error("Choose either --config-dir or a positional setup directory, not both.");
        if (!arguments_[2]) arguments_[2] = selectedDirectory;
      } else if (["doctor", "workers", "jobs", "job", "wait", "submit-diagnostic", "submit-benchmark", "drain", "resume"].includes(command)) {
        const profiles = readLocalSmokeSetup(selectedDirectory).profiles;
        const role = command === "doctor" ? arguments_[0] :
          (["workers", "drain", "resume"].includes(command) ? "admin" : "client");
        const filename = role === "control-plane" ? "control-plane.env" :
          role === "worker" ? "worker.env" :
          role === "admin" ? "admin.env" : "client.env";
        const profile = profiles[filename];
        // Do not mix inherited GPULINK settings with an explicitly selected installation.
        for (const key of Object.keys(profile)) {
          if (Object.hasOwn(process.env, key)) {
            throw new Error(`Inherited ${key} conflicts with selected local configuration; clear it before continuing.`);
          }
        }
        Object.assign(process.env, profile);
      }
    }
    if (command === "init" && explicitDirectory) {
      if (arguments_.length !== 1 || arguments_[0] !== "local") {
        throw new Error("Use either --config-dir or an init output directory, not both.");
      }
      arguments_.push(explicitDirectory);
    }
  switch (command) {
    case "init":
      process.exitCode = runLocalInit(arguments_);
      break;
    case "local":
      process.exitCode = arguments_[0] === "worker"
        ? arguments_[1] === "start"
          ? await runLocalWorkerStart(arguments_.slice(2), selectedDirectory)
          : arguments_[1] === "stop"
            ? await runLocalWorkerStop(arguments_.slice(2), selectedDirectory)
            : arguments_[1] === "status"
              ? await runLocalStatus(arguments_.slice(2), selectedDirectory)
              : (console.error("Usage: gpulink local worker start --accept-assigned-work | stop | status"), 2)
        : arguments_[0] === "status"
        ? await runLocalStatus(arguments_.slice(1), selectedDirectory)
        : arguments_[0] === "start"
          ? await runLocalStart(arguments_.slice(1), selectedDirectory)
          : arguments_[0] === "stop"
            ? await runLocalStop(arguments_.slice(1), selectedDirectory)
            : await runLocalSmoke(arguments_);
      break;
    case "doctor":
      process.exitCode = runDoctor(arguments_);
      break;
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
      usage(true);
      process.exitCode = 2;
  }
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
  // Match the already-accepted worker transport policy before any bearer is sent.
  const rawUrl = requiredEnvironment("GPULINK_URL");
  let baseUrl;
  try {
    baseUrl = normalizeWorkerControlPlaneUrl(rawUrl);
  } catch {
    throw new Error("GPULINK_URL requires HTTPS outside exact localhost loopback and must omit URL credentials, query, and fragment.");
  }
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
    redirect: "error",
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

function usage(error = true) {
  const output = error ? console.error : console.log;
  output(`Usage:
  gpulink [--config-dir DIRECTORY] init local [output-directory]
  gpulink [--config-dir DIRECTORY] local worker start --accept-assigned-work
  gpulink [--config-dir DIRECTORY] local worker stop
  gpulink [--config-dir DIRECTORY] local worker status
  gpulink [--config-dir DIRECTORY] local start
  gpulink [--config-dir DIRECTORY] local stop
  gpulink [--config-dir DIRECTORY] local status
  gpulink [--config-dir DIRECTORY] local smoke --real-gpu [setup-directory]
  gpulink [--config-dir DIRECTORY] doctor <control-plane|worker>
  gpulink [--config-dir DIRECTORY] workers
  gpulink [--config-dir DIRECTORY] jobs
  gpulink [--config-dir DIRECTORY] job <job-id>
  gpulink [--config-dir DIRECTORY] submit-diagnostic [minimum-vram-mib]
  gpulink [--config-dir DIRECTORY] submit-benchmark [matrix-size] [warmup-iterations] [measured-iterations]
  gpulink [--config-dir DIRECTORY] wait <job-id>
  gpulink [--config-dir DIRECTORY] drain <worker-id>
  gpulink [--config-dir DIRECTORY] resume <worker-id>
  gpulink --version | --help

Default local setup: ~/.gpulink/instances/local
Remote/non-local operations require separately configured GPULINK_* environment values.`);
}
