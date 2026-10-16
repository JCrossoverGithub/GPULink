/**
 * DP3C2A candidate: bounded, credential-free GPULink adapter IPC v1 subprocess.
 * NOT installed in the worker, NOT an OS sandbox, NOT an adapter loader.
 * Callers must supply an operator-approved absolute executable/arguments.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ADAPTER_IPC_TYPES as T,
  ADAPTER_IPC_MAX_FRAME_BYTES,
  createAdapterIpcDecoder,
  decodeAdapterIpcJson,
  decodeAdapterIpcText,
  encodeAdapterIpcFrame,
  encodeAdapterIpcJson,
} from "./adapter-ipc-v1.mjs";

const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 262_144;
const MAX_STDERR_BYTES = 8192;
const MAX_FRAME_COUNT = 8192;

function failure(code) {
  const error = new Error(`GPULink adapter subprocess: ${code}`);
  error.code = code;
  return error;
}

function ms(value, label, low, high) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw failure(`invalid_${label}`);
  }
  return value;
}

function validate(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw failure("invalid_options");
  }
  const {
    executable, args = [], sessionId, onFrame,
    startupTimeoutMs = 2_000, sessionTimeoutMs = 30_000,
    terminateGraceMs = 150, signal, cudaVisibleDevices = null,
  } = options;
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
      executable.includes("\0") || executable.length > 4096) {
    throw failure("absolute_executable_required");
  }
  if (!Array.isArray(args) || args.length > 16 || args.some(
    (arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) {
    throw failure("invalid_args");
  }
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw failure("invalid_session_id");
  }
  if (typeof onFrame !== "function") throw failure("on_frame_required");
  if (signal !== undefined && (typeof signal !== "object" || signal === null ||
    typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw failure("invalid_abort_signal");
  }
  // Worker-selected NVIDIA GPU identity only. This is a placement hint for
  // cooperative operator-trusted workloads, NOT GPU isolation or a grant.
  if (cudaVisibleDevices !== null &&
      (typeof cudaVisibleDevices !== "string" ||
       !/^GPU-[a-fA-F0-9-]{32,64}$/u.test(cudaVisibleDevices))) {
    throw failure("invalid_cuda_visible_devices");
  }
  ms(startupTimeoutMs, "startup_timeout", 1, 60_000);
  ms(sessionTimeoutMs, "session_timeout", 1, 300_000);
  ms(terminateGraceMs, "termination_grace", 10, 5_000);
  if (signal?.aborted) throw failure("cancelled");
  return { executable, args, sessionId, onFrame, startupTimeoutMs,
    sessionTimeoutMs, terminateGraceMs, signal, cudaVisibleDevices };
}

/**
 * Starts an IPC process; promise `ready` resolves after the strict READY handshake.
 * `completed` resolves only on END echo + exit(0), rejects on cancellation/failure.
 * onFrame runs synchronously and MUST NOT throw or block. Workload credits are separate.
 */
export function startAdapterSubprocess(options) {
  const config = validate(options);
  const decoder = createAdapterIpcDecoder();
  let mode = "starting";
  let outputBytes = 0;
  let framesSeen = 0;
  let pendingWrites = 0;
  let endAcknowledged = false;
  let stoppedReason = null;
  let readySettled = false;
  let doneSettled = false;
  let readyResolve, readyReject, doneResolve, doneReject;
  let killTimer;
  let startupTimer;
  let lifetimeTimer;
  let abortHandler;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve; readyReject = reject;
  });
  const completed = new Promise((resolve, reject) => {
    doneResolve = resolve; doneReject = reject;
  });
  // Consumers can choose to await either promise without spurious unhandled rejections.
  ready.catch(() => {});
  completed.catch(() => {});

  const child = spawn(config.executable, config.args, {
    shell: false,
    env: {
      LANG: "C", LC_ALL: "C",
      ...(config.cudaVisibleDevices === null ? {} : {
        CUDA_VISIBLE_DEVICES: config.cudaVisibleDevices,
      }),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  function settleReady(err) {
    if (readySettled) return;
    readySettled = true;
    if (err) readyReject(err);
    else readyResolve();
  }

  function terminate(reason) {
    if (stoppedReason) return;
    stoppedReason = reason;
    mode = "stopping";
    settleReady(reason);
    try { child.stdin.destroy(); } catch { /* already closed */ }
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, config.terminateGraceMs);
  }

  function receive(frame) {
    framesSeen++;
    if (framesSeen > MAX_FRAME_COUNT) throw failure("output_frame_budget_exceeded");
    if (mode === "starting") {
      if (frame.type !== T.READY) throw failure("ready_required");
      const handshake = decodeAdapterIpcJson(frame, T.READY);
      if (Object.keys(handshake).sort().join(",") !== "protocol,ready,version" ||
          handshake.protocol !== "gpulink.adapter.ipc" ||
          handshake.version !== 1 || handshake.ready !== true) {
        throw failure("invalid_ready_handshake");
      }
      mode = "running";
      clearTimeout(startupTimer);
      settleReady(null);
      return;
    }
    if (mode === "stopping" || mode === "acknowledged") {
      throw failure("unexpected_terminal_frame");
    }
    if (frame.type === T.BINARY || frame.type === T.TEXT) {
      if (mode !== "running" && mode !== "ending") throw failure("application_frame_after_end");
      if (frame.type === T.TEXT) decodeAdapterIpcText(frame.payload);
      try {
        config.onFrame(Object.freeze({
          type: frame.type,
          payload: Buffer.from(frame.payload),
        }));
      } catch { throw failure("application_callback_failed"); }
      return;
    }
    if (frame.type === T.END && frame.payload.length === 0 && mode === "ending") {
      endAcknowledged = true;
      mode = "acknowledged";
      return;
    }
    throw failure("invalid_adapter_direction_or_state");
  }

  child.stdout.on("data", (data) => {
    if (stoppedReason) return;
    outputBytes += data.length;
    if (outputBytes > MAX_WIRE_BYTES) {
      terminate(failure("output_byte_budget_exceeded")); return;
    }
    try {
      for (const frame of decoder.push(data)) receive(frame);
    } catch (err) {
      terminate(failure(err.code || "invalid_stdout_frame"));
    }
  });

  let stderrBytes = 0;
  child.stderr.on("data", (data) => {
    stderrBytes += data.length;
    if (stderrBytes > MAX_STDERR_BYTES) {
      terminate(failure("stderr_budget_exceeded"));
    }
    // Intentionally discard all subprocess stderr, including secrets and paths.
  });

  child.stdin.on("error", () => {
    if (!stoppedReason && mode !== "acknowledged") {
      terminate(failure("stdin_failed"));
    }
  });
  child.stdout.on("error", () => terminate(failure("stdout_failed")));
  child.stderr.on("error", () => terminate(failure("stderr_failed")));
  child.on("error", () => terminate(failure("spawn_failed")));

  child.on("close", (code) => {
    clearTimeout(startupTimer);
    clearTimeout(lifetimeTimer);
    clearTimeout(killTimer);
    if (abortHandler) config.signal?.removeEventListener("abort", abortHandler);
    if (doneSettled) return;
    doneSettled = true;
    let err = stoppedReason;
    if (!err) {
      try { decoder.finish(); }
      catch { err = failure("truncated_output"); }
    }
    if (!err && !(endAcknowledged && code === 0)) {
      err = failure("adapter_incomplete_or_failed");
    }
    mode = "closed";
    settleReady(err || failure("adapter_closed_before_ready"));
    if (err) doneReject(err);
    else doneResolve();
  });

  startupTimer = setTimeout(() => terminate(failure("startup_deadline_exceeded")),
    config.startupTimeoutMs);
  lifetimeTimer = setTimeout(() => terminate(failure("session_deadline_exceeded")),
    config.sessionTimeoutMs);
  if (config.signal) {
    abortHandler = () => terminate(failure("cancelled"));
    config.signal.addEventListener("abort", abortHandler, { once: true });
    if (config.signal.aborted) terminate(failure("cancelled"));
  }

  async function writeFrame(type, payload) {
    if (mode !== "running") throw failure("session_not_writable");
    const wire = encodeAdapterIpcFrame(type, payload);
    if (pendingWrites + wire.length > MAX_PENDING_WRITE_BYTES) {
      throw failure("pending_write_budget_exceeded");
    }
    pendingWrites += wire.length;
    await new Promise((resolve, reject) => {
      try {
        child.stdin.write(wire, (err) => {
          pendingWrites -= wire.length;
          if (err || stoppedReason || mode === "closed") reject(stoppedReason || failure("stdin_failed"));
          else resolve();
        });
      } catch {
        pendingWrites -= wire.length;
        reject(failure("stdin_failed"));
      }
    });
  }

  function sendBinary(bytes) {
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
      return Promise.reject(failure("invalid_payload"));
    }
    if (bytes.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES) {
      return Promise.reject(failure("frame_too_large"));
    }
    return writeFrame(T.BINARY, Buffer.from(bytes));
  }

  function sendText(text) {
    if (typeof text !== "string") return Promise.reject(failure("invalid_text"));
    return writeFrame(T.TEXT, Buffer.from(text, "utf8"));
  }

  async function end() {
    if (mode !== "running") throw failure("session_not_writable");
    mode = "ending";
    // Explicitly flush previously scheduled writes (not workload consumption).
    await new Promise((resolve, reject) => {
      child.stdin.write(encodeAdapterIpcFrame(T.END), (err) => {
        if (err) reject(failure("stdin_failed")); else resolve();
      });
    });
    child.stdin.end();
    return completed;
  }

  function cancel() {
    if (mode === "closed" || stoppedReason) return;
    // CANCEL is best-effort; no success is ever inferred from it.
    if (mode === "running") {
      try { child.stdin.write(encodeAdapterIpcFrame(T.CANCEL)); } catch { /* ignore */ }
    }
    terminate(failure("cancelled"));
  }

  if (!stoppedReason) {
    try { child.stdin.write(encodeAdapterIpcJson(T.HELLO, {
      protocol: "gpulink.adapter.ipc", version: 1, sessionId: config.sessionId,
    })); }
    catch { terminate(failure("stdin_failed")); }
  }

  return Object.freeze({ ready, completed, sendBinary, sendText, end, cancel,
    get state() { return mode; } });
}
