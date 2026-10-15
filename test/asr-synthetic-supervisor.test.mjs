import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  launchSyntheticAsrRuntime,
  SyntheticAsrRuntimeError,
} from "../src/worker/asr-synthetic-supervisor.mjs";

function resolvePython() {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate,
      ["-c", "import os,sys;print(os.path.realpath(sys.executable))"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) {
      return result.stdout.trim();
    }
  }
  return null;
}
const pythonExecutable = resolvePython();
const scriptPath = fileURLToPath(new URL("../scripts/asr/synthetic_runtime.py", import.meta.url));
const modelId = "example/synthetic-asr";
const revision = "0".repeat(40);
const options = { pythonExecutable, scriptPath, modelId, revision,
  startupTimeoutMs: 2_000, ackTimeoutMs: 1_000, terminateGraceMs: 150 };
const opt = (overrides = {}) => ({ ...options, ...overrides });
const audio = (sequence = 0, sampleOffset = 0, samples = 640) => ({
  sequence, sampleOffset, pcm: Buffer.alloc(samples * 2),
});
const assertCode = (code) => (error) =>
  error instanceof SyntheticAsrRuntimeError && error.code === code;

function pythonTest(name, handler) {
  test(name, { skip: !pythonExecutable && "No local Python interpreter" }, handler);
}

pythonTest("synthetic IPC delivers ordered consumption ACK and completes with a reaped child", async () => {
  const child = await launchSyntheticAsrRuntime(opt());
  try {
    assert.equal(child.snapshot().state, "ready");
    assert.equal(child.snapshot().pendingSamples, 0);
    const result = await child.sendAudio(audio());
    assert.deepEqual(result, { sequence: 0, sampleCount: 640, endSample: 640 });
    assert.equal(child.snapshot().pendingSamples, 0);
    const p = child.end(0);
    await p;
    const exit = await child.waitForExit();
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.state, "completed");
  } finally { await child.cancel(); }
});

pythonTest("credit is NOT released on stdin write and only releases on a validated ACK", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "slow_ack", ackTimeoutMs: 2_000 }));
  try {
    const p = child.sendAudio(audio());
    assert.equal(child.snapshot().pendingSamples, 640);
    await p;
    assert.equal(child.snapshot().pendingSamples, 0);
    await child.end(0);
  } finally { await child.cancel(); }
});

pythonTest("bad ACK is rejected and the runtime is terminated", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "bad_ack" }));
  try {
    await assert.rejects(child.sendAudio(audio()), assertCode("runtime_protocol_invalid"));
    const exit = await child.waitForExit();
    assert.equal(exit.state, "failed");
  } finally { await child.cancel(); }
});

pythonTest("a crashed Python sidecar rejects pending work instead of reporting success", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "crash_on_audio" }));
  try {
    await assert.rejects(child.sendAudio(audio()), assertCode("runtime_exited_unexpectedly"));
    assert.equal((await child.waitForExit()).state, "failed");
  } finally { await child.cancel(); }
});

pythonTest("no ACK eventually times out, terminates child, and rejects work", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "no_ack", ackTimeoutMs: 300 }));
  try {
    await assert.rejects(child.sendAudio(audio()), assertCode("runtime_ack_timeout"));
    assert.equal((await child.waitForExit()).state, "failed");
  } finally { await child.cancel(); }
});

pythonTest("no-ready startup times out and reaps the child before failing", async () => {
  await assert.rejects(
    launchSyntheticAsrRuntime(opt({ mode: "no_ready", startupTimeoutMs: 300 })),
    assertCode("runtime_startup_timeout"),
  );
});

pythonTest("incorrect model readiness cannot certify a session", async () => {
  await assert.rejects(
    launchSyntheticAsrRuntime(opt({ mode: "wrong_ready" })),
    assertCode("runtime_protocol_invalid"),
  );
});

pythonTest("oversized stdout is fatal and cannot be forwarded as ASR output", async () => {
  await assert.rejects(
    launchSyntheticAsrRuntime(opt({ mode: "oversized_output" })),
    assertCode("runtime_output_limit"),
  );
});

pythonTest("invalid input never advances audio sequencing", async () => {
  const child = await launchSyntheticAsrRuntime(opt());
  try {
    assert.throws(() => child.sendAudio(audio(1)), assertCode("input_invalid"));
    assert.throws(() => child.sendAudio(audio(0, 0, 3201)), assertCode("input_invalid"));
    assert.throws(() => child.sendAudio({ sequence: 0, sampleOffset: 0, pcm: Buffer.alloc(3) }),
      assertCode("input_invalid"));
    assert.equal(child.snapshot().nextSequence, 0);
    await child.sendAudio(audio());
    await child.end(0);
  } finally { await child.cancel(); }
});

pythonTest("bounded pending samples prevent an unacknowledged backlog", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "no_ack", ackTimeoutMs: 2_000 }));
  const rejected = [];
  try {
    for (let sequence = 0; sequence < 10; sequence++) {
      const p = child.sendAudio(audio(sequence, sequence * 3200, 3200));
      rejected.push(p.catch(() => {}));
    }
    assert.equal(child.snapshot().pendingSamples, 32_000);
    assert.throws(() => child.sendAudio(audio(10, 32_000, 640)),
      assertCode("backpressure_limit"));
    assert.equal(child.snapshot().nextSequence, 10);
  } finally {
    const result = await child.cancel();
    assert.equal(result.state, "cancelled");
    await Promise.all(rejected);
  }
});

pythonTest("explicit cancellation reaps child and rejects pending ACKs", async () => {
  const child = await launchSyntheticAsrRuntime(opt({ mode: "no_ack", ackTimeoutMs: 2_000 }));
  const p = child.sendAudio(audio());
  const result = await child.cancel();
  assert.equal(result.state, "cancelled");
  await assert.rejects(p, assertCode("session_cancelled"));
});

pythonTest("AbortSignal cancels the subprocess and pending work", async () => {
  const controller = new AbortController();
  const child = await launchSyntheticAsrRuntime(opt({ signal: controller.signal, mode: "no_ack" }));
  const p = child.sendAudio(audio());
  controller.abort();
  await assert.rejects(p, assertCode("session_cancelled"));
  assert.equal((await child.waitForExit()).state, "cancelled");
});

pythonTest("a pre-aborted signal does not launch a process", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    launchSyntheticAsrRuntime(opt({ signal: controller.signal })),
    assertCode("session_cancelled"),
  );
});

pythonTest("end must match actual last admitted sequence", async () => {
  const child = await launchSyntheticAsrRuntime(opt());
  try {
    assert.rejects(child.end(0), assertCode("input_invalid"));
    await child.sendAudio(audio());
    await assert.rejects(child.end(1), assertCode("input_invalid"));
    await child.end(0);
  } finally { await child.cancel(); }
});

pythonTest("SIGKILL escalates when synthetic runtime ignores SIGTERM", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX process-group signal test"); return; }
  const child = await launchSyntheticAsrRuntime(opt({ mode: "ignore_term", terminateGraceMs: 150 }));
  const result = await child.cancel();
  assert.equal(result.state, "cancelled");
  assert.ok(["SIGKILL", "SIGTERM"].includes(result.exitSignal));
});
