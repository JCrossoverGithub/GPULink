import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(root, "src/cli/main.mjs");
const host = "127.0.0.1";
const port = 8088;
const origin = `http://${host}:${port}`;
const defaultSetup = path.join(root, "data/self-hosted-local");
const profileKeys = Object.freeze({
  "control-plane.env": ["GPULINK_CONTROL_HOST", "GPULINK_CONTROL_PORT", "GPULINK_CONTROL_DATABASE", "GPULINK_CONTROL_DATA_PATH", "GPULINK_CLIENT_TOKEN", "GPULINK_WORKER_TOKEN", "GPULINK_ADMIN_TOKEN", "GPULINK_DATA_PLANE_SIGNING_KEY"],
  "worker.env": ["GPULINK_CONTROL_PLANE_URL", "GPULINK_WORKER_NAME", "GPULINK_WORKER_TOKEN"],
  "client.env": ["GPULINK_URL", "GPULINK_CLIENT_TOKEN"],
  "admin.env": ["GPULINK_URL", "GPULINK_ADMIN_TOKEN"],
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate only the exact output shape of `init local`. No secrets are returned in errors. */
export function readLocalSmokeSetup(directory = defaultSetup) {
  const target = path.resolve(directory);
  const folder = lstatSync(target);
  requireCondition(folder.isDirectory() && !folder.isSymbolicLink(), "Setup must be a real private directory, not a symlink.");
  if (process.platform !== "win32") {
    requireCondition((folder.mode & 0o077) === 0, "Setup directory is accessible to other users; require mode 0700.");
  }
  const profiles = {};
  for (const [filename, expected] of Object.entries(profileKeys)) {
    const filenamePath = path.join(target, filename);
    const file = lstatSync(filenamePath);
    requireCondition(file.isFile() && !file.isSymbolicLink(), "Generated profile must be a regular file, not a symlink.");
    if (process.platform !== "win32") {
      requireCondition((file.mode & 0o077) === 0, "Generated profile has unsafe permissions; require mode 0600.");
    }
    const parsed = parseEnv(readFileSync(filenamePath, "utf8"));
    requireCondition(Object.keys(parsed).sort().join("\0") === [...expected].sort().join("\0"), "Profile keys differ from the generated local setup; refusing to proceed.");
    profiles[filename] = parsed;
  }
  const control = profiles["control-plane.env"];
  const worker = profiles["worker.env"];
  const client = profiles["client.env"];
  const admin = profiles["admin.env"];
  requireCondition(control.GPULINK_CONTROL_HOST === host &&
    control.GPULINK_CONTROL_PORT === String(port) &&
    control.GPULINK_CONTROL_DATABASE === "sqlite" &&
    path.resolve(control.GPULINK_CONTROL_DATA_PATH) === path.join(target, "control-plane.sqlite"),
  "Control plane is not the isolated localhost/SQLite configuration.");
  requireCondition(worker.GPULINK_CONTROL_PLANE_URL === origin &&
    client.GPULINK_URL === origin && admin.GPULINK_URL === origin,
  "All service and client endpoints must match the local-only origin.");
  requireCondition(worker.GPULINK_WORKER_TOKEN === control.GPULINK_WORKER_TOKEN &&
    client.GPULINK_CLIENT_TOKEN === control.GPULINK_CLIENT_TOKEN &&
    admin.GPULINK_ADMIN_TOKEN === control.GPULINK_ADMIN_TOKEN &&
    new Set([control.GPULINK_WORKER_TOKEN, control.GPULINK_CLIENT_TOKEN,
      control.GPULINK_ADMIN_TOKEN, control.GPULINK_DATA_PLANE_SIGNING_KEY]).size === 4 &&
    [control.GPULINK_WORKER_TOKEN, control.GPULINK_CLIENT_TOKEN,
      control.GPULINK_ADMIN_TOKEN, control.GPULINK_DATA_PLANE_SIGNING_KEY]
      .every((secret) => typeof secret === "string" && secret.length >= 32),
  "Generated role credentials are missing, reused, or mismatched.");
  requireCondition(worker.GPULINK_WORKER_NAME === "local-gpu-worker", "Unexpected local worker identity.");
  try {
    const db = lstatSync(path.join(target, "control-plane.sqlite"));
    requireCondition(db.isFile() && !db.isSymbolicLink(), "SQLite path must not be a symlink or special file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { directory: target, profiles };
}

function cleanEnvironment(profile) {
  const keep = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR", "SystemRoot"];
  const environment = {};
  for (const name of keep) if (process.env[name]) environment[name] = process.env[name];
  return { ...environment, ...profile };
}

async function portAvailable() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("Loopback port 8088 is occupied; no existing process was stopped.")));
    server.listen(port, host, () => server.close(resolve));
  });
}

function launchService(script, profile) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root, env: cleanEnvironment(profile), stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.smokeEvents = [];
  child.smokeError = null;
  child.once("error", (error) => { child.smokeError = error; });
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    if (pending.length > 32_768) pending = pending.slice(-16_384);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (typeof event.event === "string") child.smokeEvents.push(event);
        if (child.smokeEvents.length > 64) child.smokeEvents.shift();
      } catch { /* Ignore non-JSON service output; never echo it or secrets. */ }
    }
  });
  child.stderr.resume(); // Drain untrusted diagnostics without printing credentials.
  return child;
}

async function waitEvent(child, kind, predicate = () => true, timeoutMs = 20_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Smoke test interrupted.");
    const found = child.smokeEvents.find((event) => event.event === kind && predicate(event));
    if (found) return found;
    if (child.smokeError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Temporary service exited before ${kind}.`);
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(`Timed out waiting for service event: ${kind}.`);
}

async function waitReady(child, signal) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Smoke test interrupted.");
    const started = child.smokeEvents.some((event) =>
      event.event === "control_plane_started" && event.address === host && event.port === port);
    if (started) {
      try {
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok && (await response.json()).status === "ready") return;
      } catch { /* Start may still be settling. */ }
    }
    if (child.smokeError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Temporary control plane exited during startup.");
    }
    await delay(100, undefined, { signal });
  }
  throw new Error("Control plane failed its owned-process readiness check.");
}

async function clientCommand(profile, args, signal) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root, env: cleanEnvironment(profile), stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let excess = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 65_536) { output = output.slice(-65_536); excess = true; }
  });
  child.stderr.resume();
  const completed = new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => child.kill(), args[0] === "wait" ? 100_000 : 20_000);
  try {
    requireCondition(await completed && !excess && !signal.aborted,
      `Local client command failed: ${args[0]}.`);
    try { return JSON.parse(output); }
    catch { throw new Error(`Invalid local client response: ${args[0]}.`); }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const finished = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]);
  if (!finished && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, delay(2_000)]);
  }
}

/** Injectable process operations keep CI completely GPU-free. */
export async function exerciseLocalSmoke(setup, operations, output = console, signal = new AbortController().signal) {
  const { profiles } = setup;
  let controlPlane;
  let worker;
  try {
    await operations.portAvailable();
    controlPlane = await operations.launch("src/control-plane/main.mjs", profiles["control-plane.env"]);
    await operations.ready(controlPlane, signal);
    output.log("PASS: Independent localhost control plane ready");
    worker = await operations.launch("src/worker/main.mjs", profiles["worker.env"]);
    const registration = await operations.event(worker, "worker_registered", undefined, 20_000, signal);
    requireCondition(/^worker_[a-f0-9]+$/i.test(registration.workerId) && registration.gpuCount > 0,
      "No physical GPU inventory registered.");
    const inventory = await operations.client(profiles["admin.env"], ["workers"], signal);
    const matching = inventory.workers?.find((entry) => entry.id === registration.workerId);
    requireCondition(matching?.status === "online" && !matching.drainMode &&
      matching.gpus?.length > 0 && matching.capabilities?.includes("diagnostic.gpu-status"),
    "New worker is not online and eligible for the diagnostic.");
    output.log("PASS: Physical GPU worker enrolled");
    const submission = await operations.client(profiles["client.env"], ["submit-diagnostic", "256"], signal);
    const id = submission.job?.id;
    requireCondition(typeof id === "string" && /^job_[a-z0-9]+$/i.test(id) &&
      submission.job.type === "diagnostic.gpu-status", "Unexpected diagnostic submission response.");
    const result = await operations.client(profiles["client.env"], ["wait", id], signal);
    requireCondition(result.job?.id === id && result.job.status === "succeeded" &&
      result.job.type === "diagnostic.gpu-status", "Diagnostic did not complete successfully.");
    await operations.event(worker, "job_started", (event) => event.jobId === id, 5_000, signal);
    await operations.event(worker, "job_succeeded", (event) => event.jobId === id, 5_000, signal);
    output.log(`PASS: Scheduled GPU diagnostic succeeded (${id})`);
    return { id, gpu: result.job.result?.gpu?.name ?? null };
  } finally {
    try { await operations.stop(worker); }
    finally { await operations.stop(controlPlane); }
  }
}

export async function runLocalSmoke(args, output = console) {
  if (args[0] !== "smoke" || args[1] !== "--real-gpu" || args.length > 3 || args[2] === "") {
    output.error("Usage: npm run cli -- local smoke --real-gpu [setup-directory]");
    output.error("Real GPU execution is opt-in; uses only an independent localhost setup.");
    return 2;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {
    output.error("GPULink local smoke requires Node.js 24 or newer.");
    return 1;
  }
  let setup;
  try { setup = readLocalSmokeSetup(args[2]); }
  catch { output.error("Local setup validation failed. Check generated profiles and private permissions; no services started."); return 1; }
  if (process.platform === "win32") {
    output.error("NOTE: NTFS ACL security cannot be verified automatically; use a private user-owned setup directory.");
  }
  const controller = new AbortController();
  // Restrict new SQLite and journal files even when the caller has a broad umask.
  const previousUmask = process.umask(0o077);
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  try {
    await exerciseLocalSmoke(setup, {
      portAvailable,
      launch: launchService,
      ready: waitReady,
      event: waitEvent,
      client: clientCommand,
      stop: stopOwnedProcess,
    }, output, controller.signal);
    output.log("PASS: Local self-hosted GPU smoke; owned processes stopped; SQLite state retained.");
    return 0;
  } catch (error) {
    // Messages use controlled operational labels; no child logs, env, or tokens.
    output.error(`FAIL: ${error.message}`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    process.umask(previousUmask);
  }
}
