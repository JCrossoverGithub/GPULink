import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchSyntheticAsrSession } from "../src/worker/asr-synthetic-session.mjs";

function resolvePython() {
  for (const name of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const result = spawnSync(name,
      ["-c", "import os,sys;print(os.path.realpath(sys.executable))"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) return result.stdout.trim();
  }
  return null;
}
const pythonExecutable = resolvePython();
const opts = (overrides = {}) => ({
  pythonExecutable,
  scriptPath: fileURLToPath(new URL("../scripts/asr/synthetic_runtime.py", import.meta.url)),
  modelId: "example/synthetic-asr",
  revision: "0".repeat(40),
  startupTimeoutMs: 2_000,
  ackTimeoutMs: 500,
  terminateGraceMs: 150,
  ...overrides,
});
function frame(sequence, sampleOffset, samples = 640) {
  const data = Buffer.alloc(16 + samples * 2);
  data.write("ASR1", 0, "ascii");
  data.writeUInt32LE(sequence, 4);
  data.writeUInt32LE(sampleOffset, 8);
  data.writeUInt32LE(samples, 12);
  return data;
}
const pythonTest = (name, fn) => test(name,
  { skip: !pythonExecutable && "Requires local Python" }, fn);

pythonTest("valid ACKs release coordinator credit and permit clean completion", async () => {
  const s = await launchSyntheticAsrSession(opts());
  try {
    assert.equal(s.snapshot().worker.state, "streaming");
    assert.equal(s.snapshot().client.state, "awaiting_start");
    s.start();
    assert.deepEqual(await s.sendAudio(frame(0, 0)),
      { sequence: 0, sampleCount: 640, endSample: 640 });
    assert.equal(s.snapshot().consumedSamples, 640);
    assert.equal(s.snapshot().client.queuedSamples, 0);
    await s.sendAudio(frame(1, 640));
    assert.equal(s.snapshot().consumedSamples, 1280);
    assert.equal(await s.end(1), "completed");
    assert.equal(s.snapshot().worker.state, "completed");
    assert.equal((await s.waitForExit()).exitCode, 0);
  } finally { await s.cancel(); }
});

pythonTest("credit stays queued until Python emits a validated ACK", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "slow_ack", ackTimeoutMs: 1_000 }));
  try {
    s.start();
    const ack = s.sendAudio(frame(0, 0));
    assert.equal(s.snapshot().client.queuedSamples, 640);
    assert.equal(s.snapshot().consumedSamples, 0);
    assert.equal(s.snapshot().runtime.pendingSamples, 640);
    await ack;
    assert.equal(s.snapshot().client.queuedSamples, 0);
    assert.equal(s.snapshot().runtime.pendingSamples, 0);
    await s.end(0);
  } finally { await s.cancel(); }
});

pythonTest("end waits for all pending consumed ACKs before successful completion", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "slow_ack", ackTimeoutMs: 1_000 }));
  try {
    s.start();
    const a0 = s.sendAudio(frame(0, 0));
    const a1 = s.sendAudio(frame(1, 640));
    const ending = s.end(1);
    assert.equal(s.snapshot().worker.state, "draining");
    await Promise.all([a0, a1]);
    assert.equal(await ending, "completed");
    assert.equal(s.snapshot().client.queuedSamples, 0);
  } finally { await s.cancel(); }
});

pythonTest("invalid audio is rejected without advancing either side", async () => {
  const s = await launchSyntheticAsrSession(opts());
  try {
    assert.throws(() => s.sendAudio(frame(0, 0)));
    s.start();
    assert.throws(() => s.start());
    assert.throws(() => s.sendAudio(frame(1, 0)));
    assert.equal(s.snapshot().client.nextSequence, 0);
    assert.equal(s.snapshot().runtime.nextSequence, 0);
    await s.sendAudio(frame(0, 0));
    await s.end(0);
  } finally { await s.cancel(); }
});

pythonTest("bad ACK fails closed and cannot produce completion", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "bad_ack" }));
  try {
    s.start();
    await assert.rejects(s.sendAudio(frame(0, 0)));
    await s.waitForExit();
    assert.notEqual(s.snapshot().worker.state, "completed");
    await assert.rejects(s.end(0));
  } finally { await s.cancel(); }
});

pythonTest("crashed child without a valid ACK interrupts the coordinator", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "crash_on_audio" }));
  try {
    s.start();
    await assert.rejects(s.sendAudio(frame(0, 0)));
    await s.waitForExit();
    assert.equal(s.snapshot().worker.state, "interrupted");
  } finally { await s.cancel(); }
});

pythonTest("slow runtime cannot create unbounded pending audio", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "no_ack", ackTimeoutMs: 1_000 }));
  const promises = [];
  try {
    s.start();
    let accepted = 0;
    let backpressured = false;
    for (; accepted < 10; accepted++) {
      try {
        promises.push(s.sendAudio(frame(accepted, accepted * 3200, 3200)));
      } catch (error) {
        assert.equal(error.code, "backpressure_limit");
        backpressured = true;
        break;
      }
    }
    const snapshot = s.snapshot();
    assert.ok(accepted > 0, "at least one frame must enter the runtime");
    assert.ok(snapshot.client.queuedSamples <= 32_000);
    assert.ok(snapshot.runtime.pendingSamples <= 32_000);
    if (backpressured) {
      // Underlying OS pipe limits may trip before the logical queue bound.
      // Runtime rejection must interrupt the session, never complete it.
      assert.equal(snapshot.worker.state, "interrupted");
      assert.equal(snapshot.runtime.nextSequence, accepted);
    } else {
      assert.equal(snapshot.client.queuedSamples, 32_000);
      assert.equal(snapshot.runtime.pendingSamples, 32_000);
      assert.throws(() => s.sendAudio(frame(10, 32_000)));
      assert.equal(s.snapshot().client.nextSequence, 10);
      assert.equal(s.snapshot().runtime.nextSequence, 10);
    }
  } finally {
    await s.cancel();
    await Promise.allSettled(promises);
  }
});

pythonTest("client cancellation terminates Python and remains terminal", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "no_ack", ackTimeoutMs: 1_000 }));
  s.start();
  const p = s.sendAudio(frame(0, 0));
  const exit = await s.cancel();
  await assert.rejects(p);
  assert.equal(exit.state, "cancelled");
  assert.equal(s.snapshot().worker.state, "cancelled");
  assert.notEqual(s.snapshot().worker.state, "completed");
});

pythonTest("disconnect reaps Python and leaves an interrupted session", async () => {
  const s = await launchSyntheticAsrSession(opts());
  s.start();
  const exit = await s.disconnect();
  assert.equal(exit.state, "cancelled");
  assert.equal(s.snapshot().worker.state, "interrupted");
});

pythonTest("preaborted startup never creates an active session", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchSyntheticAsrSession(opts({ signal: controller.signal })));
});

pythonTest("missing ACK times out, reaps Python, and never becomes success", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "no_ack", ackTimeoutMs: 300 }));
  try {
    s.start();
    await assert.rejects(s.sendAudio(frame(0, 0)));
    const exit = await s.waitForExit();
    assert.equal(exit.state, "failed");
    assert.equal(s.snapshot().worker.state, "interrupted");
    assert.notEqual(s.snapshot().worker.state, "completed");
  } finally { await s.cancel(); }
});

pythonTest("cancel while draining cannot race into successful completion", async () => {
  const s = await launchSyntheticAsrSession(opts({ mode: "no_ack", ackTimeoutMs: 1_000 }));
  s.start();
  const ack = s.sendAudio(frame(0, 0));
  const ending = s.end(0);
  const exit = await s.cancel();
  await assert.rejects(ack);
  await assert.rejects(ending);
  assert.equal(exit.state, "cancelled");
  assert.equal(s.snapshot().worker.state, "cancelled");
});

pythonTest("external abort terminates Python and interrupts the synthetic session", async () => {
  const controller = new AbortController();
  const s = await launchSyntheticAsrSession(opts({
    signal: controller.signal, mode: "no_ack", ackTimeoutMs: 1_000,
  }));
  s.start();
  const ack = s.sendAudio(frame(0, 0));
  controller.abort();
  await assert.rejects(ack);
  const exit = await s.waitForExit();
  assert.equal(exit.state, "cancelled");
  assert.equal(s.snapshot().worker.state, "interrupted");
});
