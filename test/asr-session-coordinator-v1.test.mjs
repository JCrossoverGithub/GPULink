import test from "node:test";
import assert from "node:assert/strict";
import { AsrProtocolError } from "../src/shared/asr-protocol-v1.mjs";
import { createAsrSessionCoordinator } from "../src/shared/asr-session-coordinator-v1.mjs";

const modelId = "example/streaming-asr";
const revision = "0000000000000000000000000000000000000000";
const msg = (type, rest = {}) => JSON.stringify({ type, ...rest });
const start = msg("asr.start.v1", { audio: {
  encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1,
}});
const ready = msg("asr.model_ready.v1", { modelId, revision });
const end = (sequence) => msg("asr.end.v1", { lastSequence: sequence });
const partial = (segmentId, revision_, startSample, endSample) =>
  msg("asr.partial.v1", { segmentId, revision: revision_, startSample, endSample, text: "hi" });
const final = (segmentId, revision_, startSample, endSample) =>
  msg("asr.final.v1", { segmentId, revision: revision_, startSample, endSample, text: "hi" });
const completed = (sequence) => msg("asr.completed.v1", { lastSequence: sequence });
const failure = (fn) => assert.throws(fn, AsrProtocolError);
const make = () => createAsrSessionCoordinator({ modelId, revision });
function audio(sequence, offset, samples = 640) {
  const bytes = Buffer.alloc(16 + samples * 2);
  bytes.write("ASR1", 0, "ascii");
  bytes.writeUInt32LE(sequence, 4);
  bytes.writeUInt32LE(offset, 8);
  bytes.writeUInt32LE(samples, 12);
  return bytes;
}
function primed() {
  const session = make();
  session.onWorkerMessage(ready);
  session.onClientControl(start);
  return session;
}

test("model readiness gates client start and audio", () => {
  const s = make();
  failure(() => s.onClientControl(start));
  failure(() => s.onClientAudio(audio(0, 0)));
  assert.equal(s.snapshot().client.state, "awaiting_start");
  s.onWorkerMessage(ready);
  s.onClientControl(start);
  assert.equal(s.snapshot().client.state, "streaming");
  failure(() => s.onWorkerMessage(ready));
});

test("cannot emit partial or final for unsent audio", () => {
  const s = primed();
  failure(() => s.onWorkerMessage(partial(1, 1, 0, 640)));
  s.onClientAudio(audio(0, 0));
  failure(() => s.onWorkerMessage(partial(1, 1, 0, 640)));
  assert.equal(s.snapshot().worker.activeSegment, null);
  s.onSamplesConsumed(640);
  s.onWorkerMessage(partial(1, 1, 0, 640));
  s.onWorkerMessage(final(1, 2, 0, 640));
  assert.equal(s.snapshot().worker.lastFinalEndSample, 640);
});

test("partial consumption constrains transcript end sample", () => {
  const s = primed();
  s.onClientAudio(audio(0, 0));
  s.onSamplesConsumed(320);
  failure(() => s.onWorkerMessage(final(1, 1, 0, 640)));
  s.onWorkerMessage(final(1, 1, 0, 320));
  assert.equal(s.snapshot().consumedSamples, 320);
});

test("completion requires input end and drained audio queue", () => {
  const s = primed();
  s.onClientAudio(audio(0, 0));
  failure(() => s.onWorkerMessage(completed(0)));
  s.onClientControl(end(0));
  failure(() => s.onWorkerMessage(completed(0)));
  assert.equal(s.snapshot().worker.state, "draining");
  s.onSamplesConsumed(640);
  s.onWorkerMessage(final(1, 1, 0, 640));
  s.onWorkerMessage(completed(0));
  assert.equal(s.snapshot().worker.state, "completed");
  failure(() => s.onClientAudio(audio(1, 640)));
});

test("end sequencing must be valid without mutating either side", () => {
  const s = primed();
  failure(() => s.onClientControl(end(0)));
  s.onClientAudio(audio(0, 0));
  failure(() => s.onClientControl(end(1)));
  assert.equal(s.snapshot().client.state, "streaming");
  assert.equal(s.snapshot().worker.state, "streaming");
  s.onClientControl(end(0));
  assert.equal(s.snapshot().worker.inputEndSequence, 0);
});

test("ingress queue bound survives coordinator and rejected frames", () => {
  const s = primed();
  for (let i = 0; i < 50; i++) s.onClientAudio(audio(i, i * 640));
  failure(() => s.onClientAudio(audio(50, 50 * 640)));
  assert.equal(s.snapshot().client.queuedSamples, 32_000);
  assert.equal(s.snapshot().client.nextSequence, 50);
  s.onSamplesConsumed(640);
  s.onClientAudio(audio(50, 50 * 640));
  assert.equal(s.snapshot().client.nextSequence, 51);
});

test("consumption credit never exceeds admitted frames", () => {
  const s = primed();
  failure(() => s.onSamplesConsumed(1));
  s.onClientAudio(audio(0, 0));
  failure(() => s.onSamplesConsumed(641));
  assert.equal(s.snapshot().consumedSamples, 0);
  s.onSamplesConsumed(640);
  assert.equal(s.snapshot().consumedSamples, 640);
  failure(() => s.onSamplesConsumed(1));
});

test("cancellation before model readiness ends without success", () => {
  const s = make();
  s.onClientControl(msg("asr.cancel.v1"));
  failure(() => s.onWorkerMessage(completed(0)));
  s.onWorkerMessage(msg("asr.cancelled.v1"));
  assert.equal(s.snapshot().worker.state, "cancelled");
  failure(() => s.onWorkerMessage(ready));
});

test("cancellation during draining prevents later completion", () => {
  const s = primed();
  s.onClientAudio(audio(0, 0));
  s.onClientControl(end(0));
  s.onClientControl(msg("asr.cancel.v1"));
  failure(() => s.onWorkerMessage(completed(0)));
  s.onWorkerMessage(msg("asr.cancelled.v1"));
  assert.equal(s.snapshot().worker.state, "cancelled");
});

test("terminal error or disconnection permanently blocks activity", () => {
  const failed = make();
  failed.onWorkerMessage(msg("asr.error.v1", { code: "model_load_failed", retryable: false }));
  assert.equal(failed.snapshot().worker.state, "failed");
  failure(() => failed.onClientControl(start));
  const disconnected = primed();
  assert.equal(disconnected.onDisconnected(), "interrupted");
  failure(() => disconnected.onClientAudio(audio(0, 0)));
  failure(() => disconnected.onWorkerMessage(final(1, 1, 0, 640)));
});

test("worker cannot finalize or cancel without corresponding client action", () => {
  const s = primed();
  failure(() => s.onWorkerMessage(msg("asr.cancelled.v1")));
  failure(() => s.onWorkerMessage(completed(0)));
  assert.equal(s.snapshot().worker.state, "streaming");
});

test("strict message directions and malformed frames remain rejected", () => {
  const s = primed();
  failure(() => s.onClientControl(ready));
  failure(() => s.onWorkerMessage(start));
  failure(() => s.onClientAudio(Buffer.alloc(4)));
  assert.equal(s.snapshot().client.nextSequence, 0);
});
