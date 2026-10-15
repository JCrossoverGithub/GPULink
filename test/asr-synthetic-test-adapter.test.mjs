import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createSyntheticAsrTestAdapter } from "../src/worker/asr-synthetic-test-adapter.mjs";
import { createSessionAdapterRegistry } from "../src/worker/session-adapters.mjs";

const modelId = "example/synthetic-asr";
const revision = "0".repeat(40);
const opts = (extra = {}) => ({
  testOnly: true, pythonExecutable: process.execPath,
  scriptPath: fileURLToPath(import.meta.url), modelId, revision, ...extra,
});

class TestSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(payload, options, callback) {
    assert.equal(options.binary, false);
    this.sent.push(JSON.parse(payload));
    queueMicrotask(() => callback?.());
  }
  text(message) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  audio() {
    const frame = Buffer.alloc(16 + 1280);
    frame.write("ASR1"); frame.writeUInt32LE(640, 12);
    this.emit("message", frame, true);
  }
  close() { this.readyState = 3; this.emit("close"); }
}

function fakeSession() {
  const events = [];
  let started = false;
  let resolveExit;
  let rejectExit;
  const exit = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  return {
    events,
    start() { if (started) throw Error("already started"); started = true; events.push("start"); },
    sendAudio(frame) { if (!started) throw Error("not started"); events.push(`audio:${frame.byteLength}`); return Promise.resolve({}); },
    async end(lastSequence) { events.push(`end:${lastSequence}`); resolveExit({state:"completed",exitCode:0}); return "completed"; },
    async cancel() { events.push("cancel"); resolveExit({state:"cancelled"}); return {state:"cancelled"}; },
    async disconnect() { events.push("disconnect"); resolveExit({state:"interrupted"}); return {state:"interrupted"}; },
    waitForExit() { return exit; },
    crash() { rejectExit(new Error("private runtime error")); },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(fn) {
  for (let i = 0; i < 80; i++) {
    if (fn()) return;
    await tick();
  }
  assert.fail("test readiness/result deadline exceeded");
}
async function setup(custom = {}) {
  const socket = new TestSocket();
  const controller = new AbortController();
  const session = custom.session ?? fakeSession();
  const adapter = createSyntheticAsrTestAdapter(opts({
    launchSession: custom.launchSession ?? (async () => session),
  }));
  const run = adapter.handleSession({id:"session-test"}, {
    signal: controller.signal, dataPlaneSocket: socket,
  });
  if (!custom.skipReady) await waitFor(() => socket.sent.some(m => m.type === "asr.model_ready.v1"));
  return {socket, controller, session, adapter, run};
}
const start = {type:"asr.start.v1",audio:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1}};

test("requires explicit synthetic-test opt-in and valid pinned identity", () => {
  assert.throws(() => createSyntheticAsrTestAdapter(opts({testOnly:false})), /test_only/);
  assert.throws(() => createSyntheticAsrTestAdapter(opts({revision:"not-a-revision"})), /ASR protocol/);
  assert.throws(() => createSyntheticAsrTestAdapter(opts({pythonExecutable:"python3"})), /configuration/);
});

test("synthetic manifest is isolated and compatible with session registry", () => {
  const adapter = createSyntheticAsrTestAdapter(opts());
  assert.equal(adapter.manifest.type, "speech.streaming.synthetic");
  assert.match(adapter.manifest.adapterId, /synthetic/);
  assert.equal(adapter.manifest.executionMode, "streaming-gateway");
  assert.equal(createSessionAdapterRegistry([adapter]).size, 1);
});

test("readiness reports missing test executable as unavailable", async () => {
  const adapter = createSyntheticAsrTestAdapter(opts({scriptPath:"/nonexistent/gpulink-synthetic-runtime.py"}));
  assert.equal(await adapter.readinessProbe(), false);
  assert.equal(await createSyntheticAsrTestAdapter(opts()).readinessProbe(), true);
});

test("model readiness follows runtime startup, not relay pairing", async () => {
  let release;
  const gate = new Promise(resolve => {release=resolve;});
  const s = fakeSession();
  const setupPromise = setup({skipReady:true, launchSession:async()=>{await gate;return s;}});
  const {socket,run} = await setupPromise;
  assert.deepEqual(socket.sent, []);
  release();
  await waitFor(() => socket.sent.some(m=>m.type === "asr.model_ready.v1"));
  socket.text({type:"asr.cancel.v1"});
  await run;
  assert.equal(socket.sent.at(-1).type, "asr.cancelled.v1");
});

test("ordered text start, binary audio and end complete cleanly", async () => {
  const {socket,run,session} = await setup();
  assert.deepEqual(socket.sent[0], {type:"asr.model_ready.v1",modelId,revision});
  socket.text(start);
  socket.audio();
  socket.text({type:"asr.end.v1",lastSequence:0});
  await run;
  assert.deepEqual(socket.sent.map(m=>m.type), ["asr.model_ready.v1","asr.completed.v1"]);
  assert.deepEqual(session.events, ["start","audio:1296","end:0"]);
});

test("cancellation returns cancelled, never completed", async () => {
  const {socket,run,session} = await setup();
  socket.text(start);
  socket.text({type:"asr.cancel.v1"});
  await run;
  assert.equal(socket.sent.at(-1).type,"asr.cancelled.v1");
  assert.equal(socket.sent.some(m=>m.type === "asr.completed.v1"), false);
  assert.ok(session.events.includes("cancel"));
});

test("audio before start fails closed and cannot complete", async () => {
  const {socket,run,session} = await setup();
  socket.audio();
  await assert.rejects(run, /input_invalid/);
  assert.equal(socket.sent.at(-1).type,"asr.error.v1");
  assert.equal(socket.sent.at(-1).code,"input_invalid");
  assert.ok(session.events.includes("disconnect"));
});

test("malformed or wrong-direction control fails closed", async () => {
  const {socket,run} = await setup();
  socket.text({type:"asr.model_ready.v1",modelId,revision});
  await assert.rejects(run,/input_invalid/);
  assert.equal(socket.sent.some(m=>m.type === "asr.completed.v1"), false);
});

test("current lease abort interrupts the sidecar, not success", async () => {
  const {socket,run,controller,session} = await setup();
  socket.text(start);
  controller.abort();
  await assert.rejects(run,/lease_lost/);
  assert.equal(socket.sent.some(m=>m.type === "asr.completed.v1"),false);
  assert.ok(session.events.includes("disconnect"));
});

test("remote WebSocket disconnect stops synthetic process", async () => {
  const {socket,run,session} = await setup();
  socket.close();
  await assert.rejects(run,/lease_lost/);
  assert.ok(session.events.includes("disconnect"));
});

test("unexpected synthetic runtime failure never emits completed", async () => {
  const {socket,run,session} = await setup();
  session.crash();
  await assert.rejects(run,/inference_failed/);
  assert.equal(socket.sent.some(m=>m.type === "asr.completed.v1"),false);
});

test("test adapter cannot accept bytes while Python startup is pending", async () => {
  let release;
  const gate = new Promise(resolve => {release=resolve;});
  const pending = await setup({skipReady:true, launchSession:async()=>{await gate; return fakeSession();}});
  pending.socket.text(start);
  release();
  await assert.rejects(pending.run,/input_invalid|inference_failed/);
  assert.equal(pending.socket.sent.some(m=>m.type === "asr.model_ready.v1"),false);
});

// Exercises actual Node <-> Python IPC behind the adapter, without any network
// or authenticated control-plane session. The latter is a separate e2e gate.
test("synthetic adapter streams through a real supervised Python fixture", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  let pythonExecutable = null;
  for (const candidate of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const result = spawnSync(candidate, ["-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
      encoding: "utf8", timeout: 2_000, windowsHide: true,
    });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) {
      pythonExecutable = result.stdout.trim();
      break;
    }
  }
  if (!pythonExecutable) return t.skip("local Python unavailable");
  const scriptPath = fileURLToPath(new URL("../scripts/asr/synthetic_runtime.py", import.meta.url));
  const { existsSync } = await import("node:fs");
  if (!existsSync(scriptPath)) return t.skip("synthetic runtime fixture unavailable");
  const adapter = createSyntheticAsrTestAdapter(opts({pythonExecutable,scriptPath}));
  assert.equal(await adapter.readinessProbe(), true);
  const socket = new TestSocket();
  const controller = new AbortController();
  const run = adapter.handleSession({id:"local-python-session"}, {
    signal:controller.signal,dataPlaneSocket:socket,
  });
  try {
    await waitFor(() => socket.sent.some(m=>m.type === "asr.model_ready.v1"));
    socket.text(start);
    socket.audio();
    socket.text({type:"asr.end.v1",lastSequence:0});
    await run;
    assert.deepEqual(socket.sent.map(m=>m.type),["asr.model_ready.v1","asr.completed.v1"]);
  } finally {
    controller.abort();
    await run.catch(() => {});
  }
});

test("cancellation during pending end cannot become successful completion", async () => {
  const session = fakeSession();
  session.end = () => new Promise(() => {}); // synthetic in-flight drain
  const {socket,run} = await setup({session});
  socket.text(start);
  socket.audio();
  socket.text({type:"asr.end.v1",lastSequence:0});
  socket.text({type:"asr.cancel.v1"});
  await run;
  assert.deepEqual(socket.sent.map(m=>m.type),[
    "asr.model_ready.v1","asr.cancelled.v1",
  ]);
});
