import {
  ASR_MAX_SESSION_SAMPLES,
  AsrProtocolError,
  parseAsrControlFrame,
} from "./asr-protocol-v1.mjs";

// This component validates application-level ordering, not the relay handshake.
// It has no timers, subprocesses, data-plane socket, or GPU side effects.
const MAX_SEGMENTS = 10_000;
const MAX_SEQUENCE = 0xffff_ffff;
const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
const uint = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const reject = () => { throw new AsrProtocolError("input_invalid"); };

export function createAsrWorkerOutput({ modelId, revision } = {}) {
  // Check with the already-reviewed parser so the expected model identity
  // has precisely the same grammar as a model_ready message.
  parseAsrControlFrame(JSON.stringify({
    type: "asr.model_ready.v1", modelId, revision,
  }), "worker");

  let state = "awaiting_model_ready";
  let inputEndSequence = null;
  let lastFinalSegmentId = 0;
  let lastFinalEndSample = 0;
  let activeSegment = null;

  function snapshot() {
    return Object.freeze({
      state, inputEndSequence, lastFinalSegmentId,
      lastFinalEndSample,
      activeSegment: activeSegment ? Object.freeze({ ...activeSegment }) : null,
    });
  }

  return Object.freeze({
    onMessage(raw) {
      const m = parseAsrControlFrame(raw, "worker");
      if (terminal.has(state)) reject();
      switch (m.type) {
        case "asr.model_ready.v1":
          if (state !== "awaiting_model_ready" ||
              m.modelId !== modelId || m.revision !== revision) reject();
          state = "streaming";
          break;

        case "asr.partial.v1":
        case "asr.final.v1": {
          if (state !== "streaming" && state !== "draining") reject();
          if (m.segmentId !== lastFinalSegmentId + 1 ||
              m.segmentId > MAX_SEGMENTS ||
              m.startSample < lastFinalEndSample) reject();
          if (activeSegment === null) {
            // First hypothesis of the next segment; a final may be first.
            activeSegment = {
              segmentId: m.segmentId, revision: m.revision,
              startSample: m.startSample, endSample: m.endSample,
            };
          } else {
            if (m.segmentId !== activeSegment.segmentId ||
                m.revision <= activeSegment.revision ||
                m.startSample !== activeSegment.startSample ||
                m.endSample < activeSegment.endSample) reject();
            activeSegment = {
              ...activeSegment,
              revision: m.revision,
              endSample: m.endSample,
            };
          }
          if (m.type === "asr.final.v1") {
            lastFinalSegmentId = m.segmentId;
            lastFinalEndSample = m.endSample;
            activeSegment = null;
          }
          break;
        }

        case "asr.completed.v1":
          if (state !== "draining" || inputEndSequence === null ||
              m.lastSequence !== inputEndSequence || activeSegment !== null) reject();
          state = "completed";
          break;

        case "asr.cancelled.v1":
          if (state !== "cancelling") reject();
          state = "cancelled";
          break;

        case "asr.error.v1":
          state = "failed";
          break;

        default:
          reject();
      }
      return m;
    },
    onClientEnd(lastSequence) {
      if (state !== "streaming" || !uint(lastSequence, 0, MAX_SEQUENCE)) reject();
      inputEndSequence = lastSequence;
      state = "draining";
    },
    onClientCancel() {
      if (terminal.has(state) || state === "cancelling") reject();
      state = "cancelling";
    },
    onDisconnected() {
      if (!terminal.has(state)) state = "interrupted";
      return state;
    },
    snapshot,
  });
}
