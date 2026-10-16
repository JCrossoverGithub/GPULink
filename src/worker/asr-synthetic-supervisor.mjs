import { spawn } from "node:child_process";
import path from "node:path";

const MAX_LINE = 16_384;
const MAX_FRAME_SAMPLES = 3_200;
const MAX_QUEUED_SAMPLES = 32_000;
const MAX_SESSION_SAMPLES = 28_800_000;
const MAX_STDERR_BYTES = 4_096;
const MAX_STDIN_BUFFER_BYTES = 16_384;
const MODES = new Set([
  "normal", "no_ready", "wrong_ready", "bad_ack", "no_ack",
  "slow_ack", "crash_on_audio", "oversized_output", "ignore_term",
]);

export class SyntheticAsrRuntimeError extends Error {
  constructor(code) {
    super(`Synthetic ASR subprocess failed: ${code}`);
    this.name = "SyntheticAsrRuntimeError";
    this.code = code;
  }
}

function reject(code) { throw new SyntheticAsrRuntimeError(code); }
function isUint(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function exactFields(obj, keys) {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).length === keys.length &&
    keys.every((key) => Object.hasOwn(obj, key));
}
function validateArgs({ pythonExecutable, scriptPath, modelId, revision,
  mode, startupTimeoutMs, ackTimeoutMs, terminateGraceMs, signal }) {
  if (typeof pythonExecutable !== "string" || !path.isAbsolute(pythonExecutable) ||
      typeof scriptPath !== "string" || !path.isAbsolute(scriptPath)) reject("invalid_configuration");
  if (typeof modelId !== "string" || modelId.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(modelId) ||
      typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision)) reject("invalid_configuration");
  if (!MODES.has(mode) || !isUint(startupTimeoutMs, 10, 30_000) ||
      !isUint(ackTimeoutMs, 10, 30_000) ||
      !isUint(terminateGraceMs, 10, 5_000)) reject("invalid_configuration");
  if (signal !== undefined && (typeof signal !== "object" || signal === null ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")) reject("invalid_configuration");
}

function killProcess(child, detached, sig) {
  try {
    if (detached && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch { /* Already exited */ }
}

// Synthetic-only harness: never registers an adapter or changes the live worker.
// Persistent stdin/stdout, ordered FIFO ACKs, bounded pending audio, safe teardown.
export async function launchSyntheticAsrRuntime({
  pythonExecutable, scriptPath, modelId, revision, mode = "normal",
  startupTimeoutMs = 3_000, ackTimeoutMs = 2_000,
  terminateGraceMs = 300, signal,
} = {}) {
  validateArgs({ pythonExecutable, scriptPath, modelId, revision, mode,
    startupTimeoutMs, ackTimeoutMs, terminateGraceMs, signal });
  if (signal?.aborted) reject("session_cancelled");

  const detached = process.platform !== "win32";
  const env = { PYTHONUNBUFFERED: "1", GPULINK_SYNTHETIC_MODE: mode };
  if (process.platform === "win32") {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  }
  const child = spawn(pythonExecutable, ["-I", "-u", scriptPath], {
    detached, cwd: path.parse(scriptPath).root, env, shell: false,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });

  let state = "starting";
  let nextSequence = 0;
  let nextSampleOffset = 0;
  let pendingSamples = 0;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBytes = 0;
  let stdinBackpressured = false;
  let completedReceived = false;
  let startupTimer;
  let killTimer;
  let settledReady = false;
  let settledEnd = false;
  let readyResolve, readyReject, endResolve, endReject;
  const pending = new Map();
  const readyPromise = new Promise((resolve, rejectPromise) => {
    readyResolve = resolve; readyReject = rejectPromise;
  });
  // Attach a handler immediately, even when launch later fails before returning.
  readyPromise.catch(() => {});
  const endPromise = new Promise((resolve, rejectPromise) => {
    endResolve = resolve; endReject = rejectPromise;
  });
  endPromise.catch(() => {});
  let closeResolve;
  const closed = new Promise((resolve) => { closeResolve = resolve; });
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function settleReady(error) {
    if (settledReady) return;
    settledReady = true;
    clearTimeout(startupTimer);
    if (error) readyReject(error);
    else readyResolve();
  }
  function settleEnd(error) {
    if (settledEnd) return;
    settledEnd = true;
    if (error) endReject(error);
    else endResolve();
  }
  function clearPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    pendingSamples = 0;
  }
  function terminate() {
    killProcess(child, detached, "SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => killProcess(child, detached, "SIGKILL"), terminateGraceMs);
    }
  }
  function fail(code) {
    if (state === "failed" || state === "cancelled" || state === "completed") return;
    state = "failed";
    const error = new SyntheticAsrRuntimeError(code);
    settleReady(error);
    settleEnd(error);
    clearPending(error);
    terminate();
  }
  function write(message) {
    if (child.stdin.destroyed || !child.stdin.writable) reject("runtime_unavailable");
    const line = Buffer.from(JSON.stringify(message) + "\n", "utf8");
    if (line.length > MAX_LINE || child.stdin.writableLength > MAX_STDIN_BUFFER_BYTES ||
        stdinBackpressured) reject("backpressure_limit");
    const acceptedWithoutBackpressure = child.stdin.write(line, (error) => {
      if (error) fail("runtime_io_failed");
    });
    if (!acceptedWithoutBackpressure) stdinBackpressured = true;
  }

  child.stdin.on("drain", () => { stdinBackpressured = false; });
  child.stdin.on("error", () => fail("runtime_io_failed"));
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > MAX_STDERR_BYTES) fail("runtime_output_limit");
    // Deliberately do not log or retain raw stderr.
  });

  function onMessage(m) {
    if (state === "failed" || state === "cancelling" || state === "cancelled" || state === "completed") return;
    if (m?.type === "asr.ipc.ready.v1") {
      if (!exactFields(m, ["type", "modelId", "revision"]) || state !== "starting" ||
          m.modelId !== modelId || m.revision !== revision) return fail("runtime_protocol_invalid");
      state = "ready";
      settleReady();
      return;
    }
    if (m?.type === "asr.ipc.consumed.v1") {
      if (!exactFields(m, ["type", "sequence", "endSample"]) ||
          (state !== "ready" && state !== "ending")) return fail("runtime_protocol_invalid");
      const first = pending.values().next().value;
      if (!first || m.sequence !== first.sequence || m.endSample !== first.endSample) {
        return fail("runtime_protocol_invalid");
      }
      pending.delete(first.sequence);
      pendingSamples -= first.sampleCount;
      clearTimeout(first.timer);
      first.resolve({ sequence: m.sequence, sampleCount: first.sampleCount,
        endSample: m.endSample });
      return;
    }
    if (m?.type === "asr.ipc.completed.v1") {
      if (!exactFields(m, ["type", "lastSequence"]) || state !== "ending" ||
          m.lastSequence !== nextSequence - 1 || pendingSamples !== 0 ||
          pending.size !== 0 || completedReceived) return fail("runtime_protocol_invalid");
      completedReceived = true;
      child.stdin.end();
      return;
    }
    fail("runtime_protocol_invalid");
  }

  child.stdout.on("data", (chunk) => {
    if (state === "failed" || state === "cancelling") return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const newline = stdoutBuffer.indexOf(10);
      if (newline < 0) {
        if (stdoutBuffer.length > MAX_LINE) fail("runtime_output_limit");
        break;
      }
      if (newline > MAX_LINE || newline === 0) { fail("runtime_output_limit"); break; }
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      try { onMessage(JSON.parse(decoder.decode(line))); }
      catch { fail("runtime_protocol_invalid"); }
      if (state === "failed") break;
    }
  });
  child.stdout.on("error", () => fail("runtime_io_failed"));
  child.on("error", () => fail("runtime_spawn_failed"));
  child.on("close", (code, exitSignal) => {
    clearTimeout(startupTimer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
    if (state === "cancelling") {
      state = "cancelled";
      const error = new SyntheticAsrRuntimeError("session_cancelled");
      settleReady(error); settleEnd(error); clearPending(error);
    } else if (state === "ending" && completedReceived && code === 0) {
      state = "completed";
      settleEnd();
    } else if (state !== "failed" && state !== "completed" && state !== "cancelled") {
      state = "failed";
      const error = new SyntheticAsrRuntimeError("runtime_exited_unexpectedly");
      settleReady(error); settleEnd(error); clearPending(error);
    }
    closeResolve(Object.freeze({ state, exitCode: code, exitSignal }));
  });
  function onAbort() {
    if (state === "cancelled" || state === "completed" || state === "failed" || state === "cancelling") return;
    state = "cancelling";
    terminate();
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  startupTimer = setTimeout(() => {
    if (state === "starting") fail("runtime_startup_timeout");
  }, startupTimeoutMs);
  try {
    write({ type: "asr.ipc.start.v1", modelId, revision,
      encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 });
  } catch { fail("runtime_io_failed"); }

  try { await readyPromise; }
  catch (error) { await closed; throw error; }

  return Object.freeze({
    get pid() { return child.pid; },
    snapshot() {
      return Object.freeze({ state, nextSequence, nextSampleOffset,
        pendingSamples, pendingFrames: pending.size, stdinBackpressured });
    },
    sendAudio({ sequence, sampleOffset, pcm } = {}) {
      if (state !== "ready") reject("runtime_unavailable");
      if (!Buffer.isBuffer(pcm) || pcm.byteLength % 2 !== 0 ||
          !isUint(pcm.byteLength / 2, 1, MAX_FRAME_SAMPLES) ||
          sequence !== nextSequence || sampleOffset !== nextSampleOffset ||
          sampleOffset + pcm.byteLength / 2 > MAX_SESSION_SAMPLES) reject("input_invalid");
      const sampleCount = pcm.byteLength / 2;
      if (pendingSamples + sampleCount > MAX_QUEUED_SAMPLES || stdinBackpressured ||
          child.stdin.writableLength > MAX_STDIN_BUFFER_BYTES) reject("backpressure_limit");
      const endSample = sampleOffset + sampleCount;
      let resolveAck, rejectAck;
      const promise = new Promise((resolve, rejectPromise) => {
        resolveAck = resolve; rejectAck = rejectPromise;
      });
      promise.catch(() => {});
      const timer = setTimeout(() => fail("runtime_ack_timeout"), ackTimeoutMs);
      pending.set(sequence, { sequence, sampleCount, endSample,
        resolve: resolveAck, reject: rejectAck, timer });
      pendingSamples += sampleCount;
      try {
        write({ type: "asr.ipc.audio.v1", sequence, sampleOffset, sampleCount,
          pcmBase64: pcm.toString("base64") });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(sequence);
        pendingSamples -= sampleCount;
        rejectAck(error);
        throw error;
      }
      nextSequence++;
      nextSampleOffset = endSample;
      return promise;
    },
    async end(lastSequence) {
      if (state !== "ready" || nextSequence === 0 ||
          lastSequence !== nextSequence - 1) reject("input_invalid");
      state = "ending";
      try { write({ type: "asr.ipc.end.v1", lastSequence }); }
      catch { fail("runtime_io_failed"); }
      return endPromise;
    },
    async cancel() {
      if (state === "completed") return closed;
      if (state !== "failed" && state !== "cancelled" && state !== "cancelling") {
        state = "cancelling";
        terminate();
      }
      return closed;
    },
    waitForExit() { return closed; },
  });
}
