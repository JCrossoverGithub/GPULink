import { spawn } from "node:child_process";
import path from "node:path";

export const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
export const MAX_PROCESS_TIMEOUT_MS = 86_400_000;

export function runBoundedProcess(command, arguments_, {
  signal,
  timeoutMs = 60_000,
  env,
  maxOutputBytes = 65_536,
} = {}) {
  validateInvocation(command, arguments_, timeoutMs, maxOutputBytes, env);

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, arguments_, {
      detached,
      env: env ?? {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let failure = null;
    let killTimer = null;

    const terminate = (code, message) => {
      if (failure) return;
      failure = processError(code, message);
      killChild(child, detached, "SIGTERM");
      killTimer = setTimeout(() => killChild(child, detached, "SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    const collect = (chunks, chunk) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate("process_output_limit", "Process exceeded its output limit");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));

    const timeout = setTimeout(
      () => terminate("process_timeout", "Process exceeded its time limit"),
      timeoutMs,
    );
    timeout.unref?.();
    const abort = () => terminate("job_aborted", "Job was aborted");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (!failure) failure = processError("process_runner_failed", error.message);
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
        reject(processError(
          "process_runner_failed",
          detail || `Process exited with ${exitSignal || exitCode}`,
        ));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function validateInvocation(command, arguments_, timeoutMs, maxOutputBytes, env) {
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    throw new TypeError("Process executable must be an absolute path");
  }
  if (!Array.isArray(arguments_)
    || arguments_.length > 128
    || arguments_.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Process arguments must be an array of at most 128 strings");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new TypeError(`Process timeout must be between 1 and ${MAX_PROCESS_TIMEOUT_MS} ms`);
  }
  if (!Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1
    || maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    throw new TypeError(
      `Process output limit must be between 1 and ${MAX_PROCESS_OUTPUT_BYTES} bytes`,
    );
  }
  if (envIsInvalid(env)) {
    throw new TypeError("Process environment must contain only string values");
  }
}

function envIsInvalid(env) {
  return env !== undefined
    && (env === null
      || typeof env !== "object"
      || Array.isArray(env)
      || Object.values(env).some((value) => typeof value !== "string"));
}

function killChild(child, detached, signal) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function processError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
