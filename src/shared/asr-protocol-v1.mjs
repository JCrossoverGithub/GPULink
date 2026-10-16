import { validateDataPlaneFrameSize } from "./data-plane-contract.mjs";

export const ASR_PROTOCOL_V1 = "gpulink.asr.v1";
export const ASR_AUDIO_HEADER_BYTES = 16;
export const ASR_MAX_CONTROL_BYTES = 16_384;
export const ASR_MAX_FRAME_SAMPLES = 3_200; // 200 ms at 16 kHz
export const ASR_MAX_QUEUED_SAMPLES = 32_000; // 2 seconds
export const ASR_MAX_SESSION_SAMPLES = 28_800_000; // 30 minutes
export const ASR_MAX_TRANSCRIPT_BYTES = 4_096;
const UINT32_MAX = 0xffff_ffff;
const VALID_ERRORS = new Set([
  "model_integrity_failed", "model_load_failed", "cuda_oom",
  "inference_failed", "runtime_timeout", "input_invalid",
  "backpressure_limit", "lease_lost", "internal_error",
]);

export class AsrProtocolError extends Error {
  constructor(code = "input_invalid") {
    super(`ASR protocol rejected: ${code}`);
    this.name = "AsrProtocolError";
    this.code = code;
  }
}
function reject(code = "input_invalid") { throw new AsrProtocolError(code); }
function uint(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function fields(obj, allowed) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) reject();
  if (Object.keys(obj).some((key) => !allowed.includes(key))) reject();
}
function rejectDuplicateJsonKeys(raw) {
  const stack = [];
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i++;
      let escaped = false;
      while (i < raw.length) {
        const c = raw[i++];
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') break;
      }
      const end = i;
      while (/\s/u.test(raw[i] ?? "")) i++;
      if (raw[i] === ":") {
        const obj = stack.at(-1);
        if (!obj || obj.keys === null) reject();
        const key = JSON.parse(raw.slice(start, end));
        if (obj.keys.has(key)) reject();
        obj.keys.add(key);
      }
    } else if (ch === "{") { stack.push({ keys: new Set() }); i++; }
    else if (ch === "[") { stack.push({ keys: null }); i++; }
    else if (ch === "}" || ch === "]") { stack.pop(); i++; }
    else i++;
  }
}

export function parseAsrControlFrame(raw, direction) {
  if (direction !== "client" && direction !== "worker") reject();
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ASR_MAX_CONTROL_BYTES) reject();
  let value;
  try { value = JSON.parse(raw); } catch { reject(); }
  rejectDuplicateJsonKeys(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.type !== "string") reject();

  switch (value.type) {
    case "asr.start.v1":
      if (direction !== "client") reject();
      fields(value, ["type", "audio"]);
      fields(value.audio, ["encoding", "sampleRateHz", "channels"]);
      if (Object.keys(value.audio).length !== 3 ||
          value.audio.encoding !== "pcm_s16le" ||
          value.audio.sampleRateHz !== 16_000 || value.audio.channels !== 1) reject();
      Object.freeze(value.audio);
      break;
    case "asr.end.v1":
      if (direction !== "client") reject();
      fields(value, ["type", "lastSequence"]);
      if (!uint(value.lastSequence, 0, UINT32_MAX)) reject();
      break;
    case "asr.cancel.v1":
      if (direction !== "client") reject();
      fields(value, ["type"]);
      break;
    case "asr.model_ready.v1":
      if (direction !== "worker") reject();
      fields(value, ["type", "modelId", "revision"]);
      if (typeof value.modelId !== "string" || value.modelId.length > 200 ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value.modelId) ||
          typeof value.revision !== "string" || !/^[a-f0-9]{40}$/u.test(value.revision)) reject();
      break;
    case "asr.partial.v1":
    case "asr.final.v1":
      if (direction !== "worker") reject();
      fields(value, ["type", "segmentId", "revision", "startSample", "endSample", "text"]);
      if (!uint(value.segmentId, 1, UINT32_MAX) ||
          !uint(value.revision, 1, UINT32_MAX) ||
          !uint(value.startSample, 0, ASR_MAX_SESSION_SAMPLES - 1) ||
          !uint(value.endSample, value.startSample + 1, ASR_MAX_SESSION_SAMPLES) ||
          typeof value.text !== "string" ||
          Buffer.byteLength(value.text, "utf8") > ASR_MAX_TRANSCRIPT_BYTES ||
          !value.text.isWellFormed()) reject();
      break;
    case "asr.completed.v1":
      if (direction !== "worker") reject();
      fields(value, ["type", "lastSequence"]);
      if (!uint(value.lastSequence, 0, UINT32_MAX)) reject();
      break;
    case "asr.cancelled.v1":
      if (direction !== "worker") reject();
      fields(value, ["type"]);
      break;
    case "asr.error.v1":
      if (direction !== "worker") reject();
      fields(value, ["type", "code", "retryable"]);
      if (!VALID_ERRORS.has(value.code) || typeof value.retryable !== "boolean") reject();
      break;
    default:
      reject();
  }
  return Object.freeze(value);
}

export function decodeAsrAudioFrame(frame, expectedSequence, expectedSampleOffset) {
  if (!Buffer.isBuffer(frame) ||
      frame.byteLength < ASR_AUDIO_HEADER_BYTES + 2 ||
      !validateDataPlaneFrameSize(frame.byteLength)) reject();
  if (frame.toString("ascii", 0, 4) !== "ASR1") reject();
  if (!uint(expectedSequence, 0, UINT32_MAX) ||
      !uint(expectedSampleOffset, 0, ASR_MAX_SESSION_SAMPLES)) reject();

  const sequence = frame.readUInt32LE(4);
  const sampleOffset = frame.readUInt32LE(8);
  const sampleCount = frame.readUInt32LE(12);

  if (sequence !== expectedSequence || sampleOffset !== expectedSampleOffset ||
      !uint(sampleCount, 1, ASR_MAX_FRAME_SAMPLES) ||
      sampleOffset + sampleCount > ASR_MAX_SESSION_SAMPLES ||
      frame.byteLength !== ASR_AUDIO_HEADER_BYTES + sampleCount * 2) reject();

  return Object.freeze({ sequence, sampleOffset, sampleCount, pcm: Buffer.from(frame.subarray(16)) });
}

export function createAsrClientIngress() {
  let state = "awaiting_start";
  let nextSequence = 0;
  let nextSampleOffset = 0;
  let queuedSamples = 0;

  return Object.freeze({
    onControl(raw) {
      const control = parseAsrControlFrame(raw, "client");
      if (control.type === "asr.start.v1") {
        if (state !== "awaiting_start") reject();
        state = "streaming";
      } else if (control.type === "asr.end.v1") {
        if (state !== "streaming" || nextSequence === 0 ||
            control.lastSequence !== nextSequence - 1) reject();
        state = "draining";
      } else if (control.type === "asr.cancel.v1") {
        if (state === "cancelled") reject();
        state = "cancelled";
      }
      return control;
    },
    onAudio(frame) {
      if (state !== "streaming") reject();
      const decoded = decodeAsrAudioFrame(frame, nextSequence, nextSampleOffset);
      if (queuedSamples + decoded.sampleCount > ASR_MAX_QUEUED_SAMPLES)
        reject("backpressure_limit");
      nextSequence++;
      nextSampleOffset += decoded.sampleCount;
      queuedSamples += decoded.sampleCount;
      return decoded;
    },
    releaseSamples(count) {
      if (!uint(count, 1, queuedSamples)) reject();
      queuedSamples -= count;
    },
    snapshot() {
      return Object.freeze({ state, nextSequence, nextSampleOffset, queuedSamples });
    },
  });
}
