#!/usr/bin/env node
import { runManagedSetup } from "./managed-lan.mjs";
import { joinInvitation } from "./managed-lan-invite.mjs";
import { defaultServerSetupDirectory, hasServerMarker, readServerSetup, runServerInit, runServerDoctor, runServerLifecycle } from "./server-profile.mjs";
import { defaultRemoteWorkerDirectory, hasRemoteWorkerMarker, runWorkerBundle, runWorkerCommand } from "./remote-worker-profile.mjs";
import { runManager } from "./manager.mjs";
import { runDoctor } from "./doctor.mjs";
import { runLocalInit } from "./local-init.mjs";
import { readLocalSmokeSetup, runLocalSmoke } from "./local-smoke.mjs";
import { runLocalStatus } from "./local-status.mjs";
import { inspectManagedLocal, runLocalStart, runLocalStop, runLocalWorkerStart, runLocalWorkerStop } from "./local-lifecycle.mjs";
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
  const serverCommand = command === "server" || (command === "init" && arguments_[0] === "server") || (command === "doctor" && arguments_[0] === "server");
  const defaultDirectory = command === "worker" ? defaultRemoteWorkerDirectory() : serverCommand ? defaultServerSetupDirectory() : defaultLocalSetupDirectory();
  const selectedDirectory = explicitDirectory ??
    (existsSync(defaultDirectory) ? defaultDirectory : null);
  if (command === "--version" || command === "version") {
    const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    console.log(JSON.parse(readFileSync(packageFile, "utf8")).version);
  } else if (command === "--help" || command === "help" || command === "-h") {
    usage(false);
  } else {
    // Server management uses a separate profile and the same owned loopback backend.
    // Local worker/smoke commands cannot operate on server installations.
    if (command === "manager") {
      process.exitCode = await runManager(arguments_, explicitDirectory);
    } else if (command === "setup") {
      process.exitCode = await runManagedSetup(arguments_, explicitDirectory);
    } else if (command === "join") {
      process.exitCode = await joinInvitation(arguments_, explicitDirectory ?? defaultRemoteWorkerDirectory());
    } else if (command === "worker") {
      process.exitCode = await runWorkerCommand(arguments_, arguments_[0] === "enroll" ? explicitDirectory : selectedDirectory);
    } else if (serverCommand) {
      process.exitCode = command === "server" && arguments_[0] === "worker-bundle" ? runWorkerBundle(arguments_.slice(1), selectedDirectory) : command === "init" ? runServerInit(arguments_.slice(1), explicitDirectory) :
        command === "doctor" ? await runServerDoctor(arguments_.slice(1), selectedDirectory) :
        await runServerLifecycle(arguments_, selectedDirectory);
    } else {
    if (hasRemoteWorkerMarker(selectedDirectory)) throw new Error("Remote worker profile selected; use gpulink worker commands.");
    if (command === "local" && hasServerMarker(selectedDirectory)) throw new Error("Server profile selected; use gpulink server start/status/stop. Local worker and smoke are not supported here.");
    if (command === "local" && arguments_[0] === "smoke" && arguments_[2] && hasServerMarker(arguments_[2])) throw new Error("Local smoke cannot use a server profile.");
    if (selectedDirectory && command !== "init") {
      if (command === "local" && arguments_[0] === "smoke") {
        if (explicitDirectory && arguments_[2]) throw new Error("Choose either --config-dir or a positional setup directory, not both.");
        if (!arguments_[2]) arguments_[2] = selectedDirectory;
      } else if (["doctor", "workers", "jobs", "job", "wait", "submit-diagnostic", "submit-benchmark", "drain", "resume", "cleanup-holds", "release-job-hold"].includes(command)) {
        const isServer = hasServerMarker(selectedDirectory);
        const setup = isServer ? readServerSetup(selectedDirectory) : readLocalSmokeSetup(selectedDirectory);
        if (isServer && command === "doctor" && arguments_[0] === "worker") throw new Error("Server profiles do not manage GPU workers; remote enrollment is separate.");
        if (isServer && command !== "doctor" && await inspectManagedLocal(setup) !== "ready") throw new Error("Server ownership is not verified; no API credential was sent.");
        const profiles = setup.profiles;
        const role = command === "doctor" ? arguments_[0] :
          (["workers", "drain", "resume", "cleanup-holds", "release-job-hold"].includes(command) ? "admin" : "client");
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
    case "cleanup-holds":
      if (arguments_.length) throw new Error("cleanup-holds accepts no arguments");
      print(await request("GET","/v1/admin/job-cleanup-holds",undefined,"admin"));
      break;
    case "release-job-hold": {
      if (arguments_.length !== 6 || arguments_[5] !== "--confirm-stopped")
        throw new Error("Specify worker ID, GPU UUID, epoch, job ID, lease ID and --confirm-stopped only after physical cleanup verification");
      const [workerId,gpuUuid,epoch,jobId,leaseId] = arguments_;
      if (!Number.isSafeInteger(Number(epoch)) || Number(epoch)<1) throw new Error("Invalid fence epoch");
      print(await request("POST","/v1/admin/job-cleanup-holds/release",
        {workerId,gpuUuid,epoch:Number(epoch),jobId,leaseId,confirmStopped:true},"admin"));
      break;
    }
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
  if (baseUrl.startsWith("https:") && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Refusing HTTPS requests with TLS verification disabled.");
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
  gpulink [--config-dir SERVER] setup server --peer PRIVATE_IPV4 [--port N] [--caddy PATH] [--apply]
  gpulink [--config-dir SERVER] setup invite --output FILE
  gpulink [--config-dir SERVER] setup cleanup
  gpulink [--config-dir WORKER] join --invite FILE [--name NAME] [--accept-assigned-work]
  gpulink [--config-dir DIRECTORY] init local [output-directory]
  gpulink [--config-dir DIRECTORY] init server --public-url HTTPS_ORIGIN
  gpulink [--config-dir DIRECTORY] server <start|status|stop>
  gpulink [--config-dir SERVER] server worker-bundle --output FILE
  gpulink [--config-dir WORKER] worker enroll --bundle FILE [--ca-file PEM] [--name NAME]
  gpulink [--config-dir WORKER] worker approve-catalog --file FILE --sha256 REVIEWED_SHA256
  gpulink [--config-dir WORKER] worker clear-catalog
  gpulink [--config-dir WORKER] worker doctor [--live] [--gpu]
  gpulink [--config-dir WORKER] worker start --accept-assigned-work
  gpulink [--config-dir WORKER] worker <status|stop>
  gpulink [--config-dir DIRECTORY] doctor server [--live]
  gpulink [--config-dir DIRECTORY] local worker start --accept-assigned-work
  gpulink [--config-dir DIRECTORY] local worker stop
  gpulink [--config-dir DIRECTORY] local worker status
  gpulink [--config-dir DIRECTORY] local start
  gpulink [--config-dir DIRECTORY] local stop
  gpulink [--config-dir DIRECTORY] local status
  gpulink [--config-dir DIRECTORY] manager [--enable-controls] [--no-open]
  gpulink [--config-dir DIRECTORY] local smoke --real-gpu [setup-directory]
  gpulink [--config-dir DIRECTORY] doctor <control-plane|worker>
  gpulink [--config-dir DIRECTORY] workers
  gpulink [--config-dir DIRECTORY] jobs
  gpulink [--config-dir DIRECTORY] job <job-id>
  gpulink [--config-dir DIRECTORY] submit-diagnostic [minimum-vram-mib]
  gpulink [--config-dir DIRECTORY] submit-benchmark [matrix-size] [warmup-iterations] [measured-iterations]
  gpulink [--config-dir DIRECTORY] wait <job-id>
  gpulink [--config-dir DIRECTORY] cleanup-holds
  gpulink [--config-dir DIRECTORY] release-job-hold WORKER GPU EPOCH JOB LEASE --confirm-stopped
  gpulink [--config-dir DIRECTORY] drain <worker-id>
  gpulink [--config-dir DIRECTORY] resume <worker-id>
  gpulink --version | --help

Default local setup: ~/.gpulink/instances/local
Default server setup: ~/.gpulink/instances/server
Server management: Linux, loopback backend, operator-managed trusted HTTPS ingress.
Default remote worker setup: ~/.gpulink/instances/worker
Remote workers use a private operator-exported bundle; external clients use separately configured GPULINK_* values.`);
}
