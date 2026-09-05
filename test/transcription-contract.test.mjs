import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPTION_AUDIO_CONTRACT,
  TRANSCRIPTION_DEFAULTS,
  validateTranscriptionPayload,
} from "../src/shared/transcription-contract.mjs";
import { createTestContext } from "./helpers.mjs";

test("normalizes the fixed TransGo streaming contract", () => {
  assert.deepEqual(validateTranscriptionPayload({}), TRANSCRIPTION_DEFAULTS);
  assert.deepEqual(validateTranscriptionPayload({
    schemaVersion: 1,
    protocol: "transgo-v1",
    audio: {
      encoding: "pcm-s16le",
      sampleRateHz: 16_000,
      channels: 1,
      frameDurationMs: 100,
    },
    interimResults: false,
  }), {
    schemaVersion: 1,
    protocol: "transgo-v1",
    audio: TRANSCRIPTION_AUDIO_CONTRACT,
    interimResults: false,
  });
});

test("rejects incompatible transcription protocols and audio formats", () => {
  assert.throws(
    () => validateTranscriptionPayload({ protocol: "other-v1" }),
    /payload\.protocol must be transgo-v1/u,
  );
  assert.throws(
    () => validateTranscriptionPayload({ audio: { sampleRateHz: 48_000 } }),
    /payload\.audio\.sampleRateHz must be an integer between 16000 and 16000/u,
  );
  assert.throws(
    () => validateTranscriptionPayload({ audio: { encoding: "opus" } }),
    /payload\.audio\.encoding must be pcm-s16le/u,
  );
  assert.throws(
    () => validateTranscriptionPayload({ interimResults: "yes" }),
    /payload\.interimResults must be a boolean/u,
  );
});

test("rejects audio content and transport controls in the durable payload", () => {
  assert.throws(
    () => validateTranscriptionPayload({ audioBytes: "AAAA" }),
    /unexpected field audioBytes/u,
  );
  assert.throws(
    () => validateTranscriptionPayload({ audio: { url: "https://example.invalid/audio" } }),
    /unexpected field url/u,
  );
  assert.throws(
    () => validateTranscriptionPayload({ command: "python" }),
    /unexpected field command/u,
  );
});

test("control plane normalizes transcription metadata before persistence", () => {
  const context = createTestContext();
  try {
    const submitted = context.service.submitJob({
      projectId: "transgo",
      type: "speech.streaming",
      constraints: {
        minVramMiB: 8_192,
        capabilities: ["speech.streaming"],
        model: "nvidia/parakeet-unified-en-0.6b",
      },
      payload: {},
    }).job;

    assert.deepEqual(submitted.payload, TRANSCRIPTION_DEFAULTS);
    assert.equal(submitted.status, "queued");
    assert.equal(submitted.constraints.model, "nvidia/parakeet-unified-en-0.6b");
  } finally {
    context.close();
  }
});
