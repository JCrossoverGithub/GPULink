import test from "node:test";
import assert from "node:assert/strict";
import { AsrProtocolError } from "../src/shared/asr-protocol-v1.mjs";
import { createAsrWorkerOutput } from "../src/shared/asr-worker-output-v1.mjs";

const modelId = "example/asr";
const revision = "a".repeat(40);
const json = (value) => JSON.stringify(value);
const ready = (overrides = {}) => json({
  type: "asr.model_ready.v1", modelId, revision, ...overrides,
});
const segment = (type, segmentId, rev, from, to, text = "sample") => json({
  type: `asr.${type}.v1`, segmentId, revision: rev,
  startSample: from, endSample: to, text,
});
const completed = (lastSequence = 1) => json({ type: "asr.completed.v1", lastSequence });
const cancelled = json({ type: "asr.cancelled.v1" });
const error = json({ type: "asr.error.v1", code: "inference_failed", retryable: false });
const fail = (fn) => assert.throws(fn, (e) => e instanceof AsrProtocolError && e.code === "input_invalid");
const make = () => createAsrWorkerOutput({ modelId, revision });

test("a pinned model becomes ready exactly once", () => {
  const out = make();
  fail(() => out.onMessage(segment("partial", 1, 1, 0, 640)));
  fail(() => out.onMessage(ready({ revision: "b".repeat(40) })));
  assert.equal(out.snapshot().state, "awaiting_model_ready");
  assert.equal(out.onMessage(ready()).type, "asr.model_ready.v1");
  assert.equal(out.snapshot().state, "streaming");
  fail(() => out.onMessage(ready()));
});

test("allows partial revisions then a final, followed by a new segment", () => {
  const out = make(); out.onMessage(ready());
  out.onMessage(segment("partial", 1, 1, 0, 640));
  out.onMessage(segment("partial", 1, 2, 0, 800));
  out.onMessage(segment("final", 1, 3, 0, 800));
  fail(() => out.onMessage(segment("partial", 1, 4, 0, 900)));
  out.onMessage(segment("final", 2, 1, 800, 1600));
  assert.deepEqual(
    [out.snapshot().lastFinalSegmentId, out.snapshot().lastFinalEndSample],
    [2, 1600],
  );
  assert.equal(out.snapshot().activeSegment, null);
});

test("rejects out of order segments, revisions, overlap and shrinking ranges", () => {
  const out = make(); out.onMessage(ready());
  fail(() => out.onMessage(segment("partial", 2, 1, 0, 100)));
  out.onMessage(segment("partial", 1, 1, 0, 100));
  fail(() => out.onMessage(segment("final", 1, 1, 0, 100)));
  fail(() => out.onMessage(segment("partial", 1, 2, 0, 80)));
  fail(() => out.onMessage(segment("final", 1, 2, 5, 120)));
  out.onMessage(segment("final", 1, 2, 0, 120));
  fail(() => out.onMessage(segment("final", 2, 1, 119, 250)));
  assert.equal(out.snapshot().lastFinalEndSample, 120);
});

test("completion needs validated end, matching sequence, and no active partial", () => {
  const out = make(); out.onMessage(ready());
  fail(() => out.onMessage(completed()));
  out.onMessage(segment("partial", 1, 1, 0, 500));
  out.onClientEnd(1);
  fail(() => out.onMessage(completed(0)));
  fail(() => out.onMessage(completed(1)));
  out.onMessage(segment("final", 1, 2, 0, 500));
  out.onMessage(completed(1));
  assert.equal(out.snapshot().state, "completed");
  fail(() => out.onMessage(error));
  fail(() => out.onClientCancel());
  assert.equal(out.onDisconnected(), "completed");
});

test("silence can finish without transcript segments, but not without model ready", () => {
  const out = make();
  fail(() => out.onClientEnd(0));
  out.onMessage(ready());
  out.onClientEnd(0);
  out.onMessage(completed(0));
  assert.equal(out.snapshot().state, "completed");
});

test("cancellation wins over success and acknowledges at most once", () => {
  const out = make(); out.onMessage(ready());
  out.onClientCancel();
  fail(() => out.onMessage(completed(1)));
  fail(() => out.onMessage(segment("partial", 1, 1, 0, 100)));
  out.onMessage(cancelled);
  assert.equal(out.snapshot().state, "cancelled");
  fail(() => out.onMessage(cancelled));
});

test("failure before readiness is terminal, and abrupt closure is incomplete", () => {
  const failed = make(); failed.onMessage(error);
  assert.equal(failed.snapshot().state, "failed");
  fail(() => failed.onMessage(ready()));
  const interrupted = make(); interrupted.onMessage(ready());
  assert.equal(interrupted.onDisconnected(), "interrupted");
  fail(() => interrupted.onMessage(completed(0)));
});

test("constructor and control directions are fail closed", () => {
  fail(() => createAsrWorkerOutput({ modelId: "../bad", revision: "main" }));
  const out = make();
  fail(() => out.onMessage(json({ type: "asr.start.v1" })));
  fail(() => out.onMessage(json({ type: "asr.completed.v1", lastSequence: 0, modelId: "spoof" })));
  assert.equal(out.snapshot().state, "awaiting_model_ready");
});
