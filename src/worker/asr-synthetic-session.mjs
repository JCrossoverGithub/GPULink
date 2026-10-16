import { createAsrSessionCoordinator } from "../shared/asr-session-coordinator-v1.mjs";
import { launchSyntheticAsrRuntime } from "./asr-synthetic-supervisor.mjs";

const START = JSON.stringify({
  type: "asr.start.v1",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
});
const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted"]);
const control = (type, details = {}) => JSON.stringify({ type, ...details });

// Synthetic-only, in-memory integration harness. No adapter, socket, or GPU.
// It bridges validated Python consumption ACKs to coordinator audio credits.
export async function launchSyntheticAsrSession(options = {}) {
  const runtime = await launchSyntheticAsrRuntime(options);
  const coordinator = createAsrSessionCoordinator({
    modelId: options.modelId, revision: options.revision,
  });
  let cancelRequested = false;
  const pending = new Set();

  function interrupt() {
    if (!TERMINAL.has(coordinator.snapshot().worker.state)) {
      coordinator.onDisconnected();
    }
  }

  // The supervisor reaps before resolving waitForExit. Unexpected exits are
  // always incomplete even if no audio acknowledgment was outstanding.
  const exited = runtime.waitForExit().then((result) => {
    if (result.state !== "completed" && !(cancelRequested && result.state === "cancelled")) {
      interrupt();
    }
    return result;
  });

  try {
    // In this synthetic fixture the runtime's validated startup ACK binds the
    // same pinned identity; only then certify application-level model readiness.
    coordinator.onWorkerMessage(control("asr.model_ready.v1", {
      modelId: options.modelId, revision: options.revision,
    }));
  } catch (error) {
    interrupt();
    await runtime.cancel();
    throw error;
  }

  return Object.freeze({
    snapshot() {
      return Object.freeze({
        ...coordinator.snapshot(),
        runtime: runtime.snapshot(),
        pendingAcknowledgments: pending.size,
      });
    },
    start() {
      return coordinator.onClientControl(START);
    },
    sendAudio(frame) {
      // Client admission remains atomic for malformed frames. A failure after
      // admission is fatal: never retry a sequence whose bytes may have been sent.
      const decoded = coordinator.onClientAudio(frame);
      let ackPromise;
      try {
        ackPromise = runtime.sendAudio(decoded);
      } catch (error) {
        interrupt();
        void runtime.cancel();
        throw error;
      }
      let tracked;
      tracked = ackPromise.then((ack) => {
        if (ack.sequence !== decoded.sequence ||
            ack.endSample !== decoded.sampleOffset + decoded.sampleCount ||
            ack.sampleCount !== decoded.sampleCount) {
          throw new Error("validated ACK mismatch");
        }
        coordinator.onSamplesConsumed(ack.sampleCount);
        return ack;
      }).catch((error) => {
        if (!cancelRequested) interrupt();
        void runtime.cancel();
        throw error;
      }).finally(() => pending.delete(tracked));
      pending.add(tracked);
      tracked.catch(() => {});
      return tracked;
    },
    async end(lastSequence) {
      coordinator.onClientControl(control("asr.end.v1", { lastSequence }));
      try {
        // Completion cannot race outstanding consumed ACK processing.
        await Promise.all([...pending]);
        await runtime.end(lastSequence);
        const exit = await exited;
        if (exit.state !== "completed" || exit.exitCode !== 0 ||
            coordinator.snapshot().client.queuedSamples !== 0) {
          throw new Error("synthetic runtime did not complete cleanly");
        }
        coordinator.onWorkerMessage(control("asr.completed.v1", { lastSequence }));
        return coordinator.snapshot().worker.state;
      } catch (error) {
        if (!cancelRequested) interrupt();
        await runtime.cancel();
        throw error;
      }
    },
    async cancel() {
      if (TERMINAL.has(coordinator.snapshot().worker.state)) {
        return runtime.cancel();
      }
      coordinator.onClientControl(control("asr.cancel.v1"));
      cancelRequested = true;
      const exit = await runtime.cancel();
      if (exit.state !== "cancelled") {
        interrupt();
        throw new Error("synthetic runtime cancellation failed");
      }
      coordinator.onWorkerMessage(control("asr.cancelled.v1"));
      return exit;
    },
    async disconnect() {
      interrupt();
      return runtime.cancel();
    },
    waitForExit() { return exited; },
  });
}
