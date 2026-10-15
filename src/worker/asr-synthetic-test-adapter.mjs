import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { ASR_MAX_CONTROL_BYTES, ASR_MAX_FRAME_SAMPLES, parseAsrControlFrame } from "../shared/asr-protocol-v1.mjs";
import { launchSyntheticAsrSession } from "./asr-synthetic-session.mjs";

const MAX_AUDIO_BYTES = 16 + ASR_MAX_FRAME_SAMPLES * 2;
const MAX_OUTPUT_BUFFER_BYTES = 65_536;
const SEND_DEADLINE_MS = 1_000;
const MANIFEST = Object.freeze({
  schemaVersion: 2,
  type: "speech.streaming.synthetic",
  adapterId: "gpulink.asr.synthetic-test.v1",
  version: "0.1.0",
  executionMode: "streaming-gateway",
});

function invalid(reason = "input_invalid") {
  const error = new Error(`Synthetic ASR test adapter rejected: ${reason}`);
  error.code = reason;
  return error;
}

function assertSocket(socket) {
  if (!socket || typeof socket.on !== "function" ||
      typeof socket.removeListener !== "function" ||
      typeof socket.send !== "function" ||
      typeof socket.readyState !== "number") throw invalid("invalid_socket");
}

function sendControl(socket, message) {
  if (socket.readyState !== 1 || socket.bufferedAmount > MAX_OUTPUT_BUFFER_BYTES) {
    return Promise.reject(invalid("connection_closed"));
  }
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(invalid("send_timeout"));
    }, SEND_DEADLINE_MS);
    timer.unref?.();
    try {
      socket.send(payload, { binary: false }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(invalid("send_failed"));
        else resolve();
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(invalid("send_failed"));
      }
    }
  });
}

// Factory is deliberately not wired into src/worker/main.mjs.
// The capability and adapter identity both explicitly say "synthetic".
export function createSyntheticAsrTestAdapter({
  testOnly = false, pythonExecutable, scriptPath, modelId, revision,
  launchSession = launchSyntheticAsrSession,
} = {}) {
  if (testOnly !== true) throw invalid("test_only_opt_in_required");
  if (typeof pythonExecutable !== "string" || !path.isAbsolute(pythonExecutable) ||
      typeof scriptPath !== "string" || !path.isAbsolute(scriptPath) ||
      typeof launchSession !== "function") throw invalid("invalid_configuration");
  parseAsrControlFrame(JSON.stringify({type: "asr.model_ready.v1", modelId, revision}), "worker");

  return Object.freeze({
    manifest: MANIFEST,
    async readinessProbe() {
      try {
        await access(pythonExecutable, fsConstants.X_OK);
        await access(scriptPath, fsConstants.R_OK);
        return true; // Test fixture readiness, NOT real GPU inference readiness.
      } catch { return false; }
    },
    async handleSession(_allocation, { signal, dataPlaneSocket } = {}) {
      assertSocket(dataPlaneSocket);
      if (signal?.aborted || dataPlaneSocket.readyState !== 1) throw invalid("session_interrupted");

      let phase = "starting";
      let session = null;
      let settled = false;
      let terminateResolve;
      let terminateReject;
      const terminal = new Promise((resolve, reject) => {
        terminateResolve = resolve;
        terminateReject = reject;
      });
      // It can reject during an asynchronous Python startup.
      void terminal.catch(() => {});
      const finish = (result) => {
        if (settled) return;
        settled = true;
        phase = result;
        terminateResolve();
      };
      const fail = (error, code = "inference_failed") => {
        if (settled) return;
        settled = true;
        phase = "failed";
        // Never forward raw process errors, paths, or diagnostic text.
        if (dataPlaneSocket.readyState === 1) {
          void sendControl(dataPlaneSocket, {
            type: "asr.error.v1", code, retryable: code === "lease_lost",
          }).catch(() => {});
        }
        const cleanup = session?.disconnect?.();
        Promise.resolve(cleanup).catch(() => {}).finally(() => {
          terminateReject(invalid(code));
        });
      };
      const onAbort = () => fail(invalid("lease_lost"), "lease_lost");
      const onClose = () => fail(invalid("session_interrupted"), "lease_lost");
      const onError = () => fail(invalid("socket_error"));
      const onMessage = (data, isBinary) => {
        if (settled) return;
        if (phase !== "streaming" && phase !== "ending") {
          fail(invalid("input_invalid"), "input_invalid");
          return;
        }
        try {
          if (isBinary) {
            if (phase !== "streaming") throw invalid("input_invalid");
            if (!Buffer.isBuffer(data) || data.byteLength > MAX_AUDIO_BYTES) {
              throw invalid("input_invalid");
            }
            // Validated admission is synchronous; ACKs remain asynchronous.
            const pendingAck = session.sendAudio(data);
            void Promise.resolve(pendingAck).catch((error) => fail(error));
            return;
          }
          const raw = typeof data === "string" ? data :
            Buffer.isBuffer(data) ? data.toString("utf8") : null;
          if (raw === null || Buffer.byteLength(raw, "utf8") > ASR_MAX_CONTROL_BYTES) {
            throw invalid("input_invalid");
          }
          const control = parseAsrControlFrame(raw, "client");
          if (control.type === "asr.start.v1") {
            if (phase !== "streaming") throw invalid("input_invalid");
            session.start();
          } else if (control.type === "asr.end.v1") {
            if (phase !== "streaming") throw invalid("input_invalid");
            phase = "ending";
            void Promise.resolve(session.end(control.lastSequence))
              .then(async (status) => {
                if (settled || phase === "cancelling") return;
                if (status !== "completed" || signal?.aborted || dataPlaneSocket.readyState !== 1) {
                  throw invalid("session_interrupted");
                }
                await sendControl(dataPlaneSocket, {
                  type: "asr.completed.v1", lastSequence: control.lastSequence,
                });
                finish("completed");
              }).catch((error) => { if (phase !== "cancelling") fail(error); });
          } else if (control.type === "asr.cancel.v1") {
            phase = "cancelling";
            void Promise.resolve(session.cancel()).then(async () => {
              if (settled) return;
              if (signal?.aborted || dataPlaneSocket.readyState !== 1) throw invalid("session_interrupted");
              await sendControl(dataPlaneSocket, { type: "asr.cancelled.v1" });
              finish("cancelled");
            }).catch((error) => fail(error));
          } else {
            throw invalid("input_invalid");
          }
        } catch (error) {
          fail(error, "input_invalid");
        }
      };

      dataPlaneSocket.on("message", onMessage);
      dataPlaneSocket.on("close", onClose);
      dataPlaneSocket.on("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        session = await launchSession({
          pythonExecutable, scriptPath, modelId, revision, signal,
        });
        if (settled || signal?.aborted || dataPlaneSocket.readyState !== 1) {
          throw invalid("session_interrupted");
        }
        void session.waitForExit().then((result) => {
          if (settled) return;
          if (phase === "ending" && result.state === "completed") return;
          if (phase === "cancelling" && result.state === "cancelled") return;
          fail(invalid("unexpected_runtime_exit"));
        }, (error) => fail(error));
        await sendControl(dataPlaneSocket, { type: "asr.model_ready.v1", modelId, revision });
        if (settled || signal?.aborted) throw invalid("session_interrupted");
        phase = "streaming";
        await terminal;
      } catch (error) {
        fail(error, signal?.aborted ? "lease_lost" : "inference_failed");
        await terminal;
      } finally {
        dataPlaneSocket.removeListener("message", onMessage);
        dataPlaneSocket.removeListener("close", onClose);
        dataPlaneSocket.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
        if (phase !== "completed" && phase !== "cancelled") {
          await session?.disconnect?.().catch(() => {});
        }
      }
    },
  });
}
