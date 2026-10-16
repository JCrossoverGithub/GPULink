import {
  AsrProtocolError,
  createAsrClientIngress,
  parseAsrControlFrame,
} from "./asr-protocol-v1.mjs";
import { createAsrWorkerOutput } from "./asr-worker-output-v1.mjs";

// Protocol-only composition: no socket, subprocess, timing, or GPU side effects.
// This layer assumes the runtime feeds it frames from the authenticated
// session and calls onSamplesConsumed only after ordered FIFO consumption.
const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted"]);
const reject = () => { throw new AsrProtocolError("input_invalid"); };

export function createAsrSessionCoordinator({ modelId, revision } = {}) {
  const ingress = createAsrClientIngress();
  const output = createAsrWorkerOutput({ modelId, revision });

  const snapshot = () => {
    const client = ingress.snapshot();
    return Object.freeze({
      client,
      worker: output.snapshot(),
      consumedSamples: client.nextSampleOffset - client.queuedSamples,
    });
  };

  function ensureActive() {
    const state = output.snapshot().state;
    if (TERMINAL.has(state) || state === "cancelling") reject();
    return state;
  }

  return Object.freeze({
    onClientControl(raw) {
      // Parse before mutating either state machine. The authenticated worker
      // adapter must only call this for the bound session's client messages.
      const message = parseAsrControlFrame(raw, "client");
      const workerState = ensureActive();
      const client = ingress.snapshot();

      if (message.type === "asr.start.v1") {
        // Phase 6A v1: do not start or buffer audio before model readiness.
        if (workerState !== "streaming" || client.state !== "awaiting_start") reject();
      } else if (message.type === "asr.end.v1") {
        if (workerState !== "streaming" || client.state !== "streaming" ||
            client.nextSequence === 0 || message.lastSequence !== client.nextSequence - 1) reject();
      } else if (message.type === "asr.cancel.v1") {
        if (client.state === "cancelled") reject();
      }

      ingress.onControl(raw);
      if (message.type === "asr.end.v1") output.onClientEnd(message.lastSequence);
      else if (message.type === "asr.cancel.v1") output.onClientCancel();
      return message;
    },

    onClientAudio(frame) {
      if (ensureActive() !== "streaming" || ingress.snapshot().state !== "streaming") reject();
      return ingress.onAudio(frame);
    },

    onSamplesConsumed(count) {
      // Not a credit-grant API. Caller must demonstrate ordered consumption
      // in its runtime integration; this module cannot verify physical I/O.
      const state = ensureActive();
      const client = ingress.snapshot();
      if ((state !== "streaming" && state !== "draining") ||
          (client.state !== "streaming" && client.state !== "draining")) reject();
      ingress.releaseSamples(count);
      return snapshot().consumedSamples;
    },

    onWorkerMessage(raw) {
      const message = parseAsrControlFrame(raw, "worker");
      const state = output.snapshot().state;
      if (TERMINAL.has(state) ||
          (state === "cancelling" && message.type !== "asr.cancelled.v1" &&
           message.type !== "asr.error.v1")) reject();
      const { client, worker, consumedSamples } = snapshot();

      if (message.type === "asr.model_ready.v1") {
        if (client.state !== "awaiting_start") reject();
      } else if (message.type === "asr.partial.v1" ||
                 message.type === "asr.final.v1") {
        if ((client.state !== "streaming" && client.state !== "draining") ||
            message.endSample > consumedSamples) reject();
      } else if (message.type === "asr.completed.v1") {
        if (client.state !== "draining" || client.queuedSamples !== 0 ||
            worker.state !== "draining") reject();
      } else if (message.type === "asr.cancelled.v1") {
        if (client.state !== "cancelled" || worker.state !== "cancelling") reject();
      }

      return output.onMessage(raw);
    },

    onDisconnected() {
      return output.onDisconnected();
    },

    snapshot,
  });
}
