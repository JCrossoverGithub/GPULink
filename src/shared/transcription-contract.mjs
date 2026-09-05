import {
  boundedInteger,
  optionalObject,
  optionalString,
  rejectUnknownFields,
  requireObject,
  ValidationError,
} from "./validation.mjs";

export const TRANSCRIPTION_TYPE = "speech.streaming";
export const TRANSCRIPTION_SCHEMA_VERSION = 1;
export const TRANSGO_PROTOCOL = "transgo-v1";
export const TRANSCRIPTION_AUDIO_CONTRACT = Object.freeze({
  encoding: "pcm-s16le",
  sampleRateHz: 16_000,
  channels: 1,
  frameDurationMs: 100,
});
export const TRANSCRIPTION_DEFAULTS = Object.freeze({
  schemaVersion: TRANSCRIPTION_SCHEMA_VERSION,
  protocol: TRANSGO_PROTOCOL,
  audio: TRANSCRIPTION_AUDIO_CONTRACT,
  interimResults: true,
});

export function validateTranscriptionPayload(value) {
  const payload = requireObject(value, "payload");
  rejectUnknownFields(payload, "payload", [
    "schemaVersion",
    "protocol",
    "audio",
    "interimResults",
  ]);

  const schemaVersion = boundedInteger(
    payload.schemaVersion,
    "payload.schemaVersion",
    {
      minimum: TRANSCRIPTION_SCHEMA_VERSION,
      maximum: TRANSCRIPTION_SCHEMA_VERSION,
      fallback: TRANSCRIPTION_SCHEMA_VERSION,
    },
  );
  const protocol = optionalString(
    payload.protocol,
    "payload.protocol",
    TRANSGO_PROTOCOL,
    { maximum: 50 },
  );
  if (protocol !== TRANSGO_PROTOCOL) {
    throw new ValidationError(`payload.protocol must be ${TRANSGO_PROTOCOL}`);
  }

  const audio = validateAudioContract(optionalObject(payload.audio, "payload.audio"));
  const interimResults = payload.interimResults ?? true;
  if (typeof interimResults !== "boolean") {
    throw new ValidationError("payload.interimResults must be a boolean");
  }

  return {
    schemaVersion,
    protocol,
    audio,
    interimResults,
  };
}

function validateAudioContract(value) {
  rejectUnknownFields(value, "payload.audio", [
    "encoding",
    "sampleRateHz",
    "channels",
    "frameDurationMs",
  ]);

  const encoding = optionalString(
    value.encoding,
    "payload.audio.encoding",
    TRANSCRIPTION_AUDIO_CONTRACT.encoding,
    { maximum: 50 },
  );
  if (encoding !== TRANSCRIPTION_AUDIO_CONTRACT.encoding) {
    throw new ValidationError(
      `payload.audio.encoding must be ${TRANSCRIPTION_AUDIO_CONTRACT.encoding}`,
    );
  }

  return {
    encoding,
    sampleRateHz: exactInteger(
      value.sampleRateHz,
      "payload.audio.sampleRateHz",
      TRANSCRIPTION_AUDIO_CONTRACT.sampleRateHz,
    ),
    channels: exactInteger(
      value.channels,
      "payload.audio.channels",
      TRANSCRIPTION_AUDIO_CONTRACT.channels,
    ),
    frameDurationMs: exactInteger(
      value.frameDurationMs,
      "payload.audio.frameDurationMs",
      TRANSCRIPTION_AUDIO_CONTRACT.frameDurationMs,
    ),
  };
}

function exactInteger(value, name, expected) {
  return boundedInteger(value, name, {
    minimum: expected,
    maximum: expected,
    fallback: expected,
  });
}
