import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_IPC_TYPES as T,
} from "../src/worker/adapter-ipc-v1.mjs";
import { startAdapterSubprocess } from "../src/worker/adapter-subprocess-supervisor.mjs";

const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"],
  { encoding: "utf8", timeout: 2000 }).trim();
const fixture = fileURLToPath(new URL("../examples/external-adapter/echo-subprocess.py", import.meta.url));
const opts = (extra = {}) => ({
  executable: python, args: ["-I", "-S", fixture],
  sessionId: "test-session-1", onFrame() {}, startupTimeoutMs: 500,
  sessionTimeoutMs: 3000, terminateGraceMs: 30, ...extra,
});

async function rejectedCode(promise, code) {
  await assert.rejects(promise, (err) => err?.code === code,
    `expected error ${code}`);
}

async function fails(script, expected, extra = {}) {
  const process = startAdapterSubprocess(opts({
    args: ["-I", "-S", "-c", script], ...extra,
  }));
  await rejectedCode(process.completed, expected);
}

test("supervised Python echo streams opaque frames, END + exit 0", async () => {
  const frames = [];
  const proc = startAdapterSubprocess(opts({ onFrame: f => frames.push(f) }));
  await proc.ready;
  assert.equal(proc.state, "running");
  await proc.sendBinary(Buffer.from([0, 255, 7, 0]));
  await proc.sendText("language-neutral ✓");
  await proc.end();
  await proc.completed;
  assert.equal(proc.state, "closed");
  assert.deepEqual(frames.map(f => f.type), [T.BINARY, T.TEXT]);
  assert.deepEqual(frames[0].payload, Buffer.from([0, 255, 7, 0]));
  assert.equal(frames[1].payload.toString("utf8"), "language-neutral ✓");
});

test("invalid command is rejected before process launch", () => {
  assert.throws(() => startAdapterSubprocess(opts({ executable: "python3" })),
    { code: "absolute_executable_required" });
  assert.throws(() => startAdapterSubprocess(opts({ sessionId: "../escape" })),
    { code: "invalid_session_id" });
  assert.throws(() => startAdapterSubprocess(opts({ onFrame: null })),
    { code: "on_frame_required" });
});

test("preaborted signal never launches a child", () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => startAdapterSubprocess(opts({ signal: controller.signal })),
    { code: "cancelled" });
});

test("explicit cancellation reaps child and cannot resolve as success", async () => {
  const proc = startAdapterSubprocess(opts());
  await proc.ready;
  proc.cancel();
  await rejectedCode(proc.completed, "cancelled");
});

test("AbortSignal cancellation propagates during running session", async () => {
  const controller = new AbortController();
  const proc = startAdapterSubprocess(opts({ signal: controller.signal }));
  await proc.ready;
  controller.abort();
  await rejectedCode(proc.completed, "cancelled");
});

test("invalid READY is rejected before frames are delivered", async () => {
  const code = 'import sys;sys.stdin.buffer.read(9);sys.stdout.buffer.write(b"GLIP"+bytes([2])+ (2).to_bytes(4,"big")+b"{}" );sys.stdout.buffer.flush()';
  const proc = startAdapterSubprocess(opts({ args: ["-I", "-S", "-c", code] }));
  await rejectedCode(proc.ready, "invalid_ready_handshake");
  await rejectedCode(proc.completed, "invalid_ready_handshake");
});

test("exits before READY never produce completed session", async () => {
  const proc = startAdapterSubprocess(opts({ args: ["-I", "-S", "-c", "import sys;sys.exit(0)"] }));
  await rejectedCode(proc.ready, "adapter_incomplete_or_failed");
  await rejectedCode(proc.completed, "adapter_incomplete_or_failed");
});

test("hung process expires during startup and is reaped", async () => {
  const script = "import time;time.sleep(10)";
  await fails(script, "startup_deadline_exceeded", { startupTimeoutMs: 30 });
});

test("session-wide deadline interrupts a ready, stalled child", async () => {
  const proc = startAdapterSubprocess(opts({ sessionTimeoutMs: 90 }));
  await proc.ready;
  await rejectedCode(proc.completed, "session_deadline_exceeded");
});

test("application listener exceptions cannot crash host", async () => {
  const proc = startAdapterSubprocess(opts({ onFrame() { throw new Error("secret"); } }));
  await proc.ready;
  await proc.sendText("trigger");
  await rejectedCode(proc.completed, "application_callback_failed");
});

test("missing executable reports a bounded error", async () => {
  const proc = startAdapterSubprocess(opts({ executable: "/definitely-not-a-real-directory/python" }));
  await rejectedCode(proc.ready, "spawn_failed");
  await rejectedCode(proc.completed, "spawn_failed");
});

test("stdout after handshake cannot impersonate second READY", async () => {
  const script = `import sys,struct
out=sys.stdout.buffer
h=lambda kind,p:out.write(b'GLIP'+struct.pack('>BI',kind,len(p))+p)
sys.stdin.buffer.read(9)
h(2,b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}')
h(2,b'{}')
out.flush()`;
  const proc = startAdapterSubprocess(opts({ args: ["-I", "-S", "-c", script] }));
  await rejectedCode(proc.completed, "invalid_adapter_direction_or_state");
});

test("early END without host end is not success", async () => {
  const script = `import sys,struct
out=sys.stdout.buffer
h=lambda k,p:b'GLIP'+struct.pack('>BI',k,len(p))+p
sys.stdin.buffer.read(9)
out.write(h(2,b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}')+h(5,b''));out.flush()`;
  const proc = startAdapterSubprocess(opts({ args: ["-I", "-S", "-c", script] }));
  await rejectedCode(proc.completed, "invalid_adapter_direction_or_state");
});

test("truncated frame never completes on zero exit", async () => {
  const script = `import sys
sys.stdin.buffer.read(9)
sys.stdout.buffer.write(b'GLIP'+bytes([2])+(200).to_bytes(4,'big')+b'{}');sys.stdout.buffer.flush()`;
  const proc = startAdapterSubprocess(opts({ args: ["-I", "-S", "-c", script] }));
  await rejectedCode(proc.completed, "truncated_output");
});

test("sending after end fails closed", async () => {
  const proc = startAdapterSubprocess(opts());
  await proc.ready;
  const ended = proc.end();
  await rejectedCode(proc.sendText("late"), "session_not_writable");
  await ended;
});

test("stderr flood is bounded and is never surfaced to callers", async () => {
  const script = "import sys,time;sys.stderr.buffer.write(b'private data'*10000);sys.stderr.buffer.flush();time.sleep(10)";
  await fails(script, "stderr_budget_exceeded");
});

test("output byte quota terminates excessive stdout", async () => {
  const script = `import sys,struct
out=sys.stdout.buffer
f=lambda k,p:b'GLIP'+struct.pack('>BI',k,len(p))+p
out.write(f(2,b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}'));out.flush()
chunk=f(3,b'x'*65000)
for i in range(350):out.write(chunk);out.flush()`;
  await fails(script, "output_byte_budget_exceeded");
});

test("supervisor does not pass inherited secrets to Python child", async () => {
  const script = `import os,sys,struct
x=b'GPULINK_PRIVATE_CREDENTIAL_FOR_TEST' in str(os.environ).encode()
f=lambda k,p:b'GLIP'+struct.pack('>BI',k,len(p))+p
out=sys.stdout.buffer
out.write(f(2,b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}'))
out.write(f(4,b'leaked' if x else b'clean'));out.flush()
sys.stdin.buffer.read()`;
  const old = process.env.GPULINK_PRIVATE_CREDENTIAL_FOR_TEST;
  process.env.GPULINK_PRIVATE_CREDENTIAL_FOR_TEST = "DO-NOT-EXPOSE";
  try {
    const seen = [];
    const proc = startAdapterSubprocess(opts({
      args: ["-I", "-S", "-c", script], onFrame: f => seen.push(f.payload.toString()),
    }));
    await proc.ready;
    // Child sends a test frame and then blocks, so wait for completion via cancellation.
    await new Promise(resolve => setTimeout(resolve, 25));
    proc.cancel();
    await rejectedCode(proc.completed, "cancelled");
    assert.deepEqual(seen, ["clean"]);
  } finally {
    if (old === undefined) delete process.env.GPULINK_PRIVATE_CREDENTIAL_FOR_TEST;
    else process.env.GPULINK_PRIVATE_CREDENTIAL_FOR_TEST = old;
  }
});

// The NVIDIA visibility hint comes from the worker-assigned GPU, not the client.
// It is deliberately an environment *hint*, not an OS-level isolation boundary.
test("supervisor exposes only the assigned CUDA GPU UUID, never inherited secrets", async () => {
  const uuid = "GPU-12345678-1234-1234-1234-123456789abc";
  const code = `import os,sys,struct
f=lambda k,p:b'GLIP'+struct.pack('>BI',k,len(p))+p
out=sys.stdout.buffer
out.write(f(2,b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}'))
out.write(f(4,os.environ.get('CUDA_VISIBLE_DEVICES','absent').encode()))
out.flush()
sys.stdin.buffer.read()`;
  const seen = [];
  const proc = startAdapterSubprocess(opts({
    args: ["-I", "-S", "-c", code], cudaVisibleDevices: uuid,
    onFrame: f => seen.push(f.payload.toString('utf8')),
  }));
  await proc.ready;
  await new Promise(resolve => setTimeout(resolve, 40));
  proc.cancel();
  await rejectedCode(proc.completed, "cancelled");
  assert.deepEqual(seen, [uuid]);
});

test("supervisor fails closed on malformed CUDA selection", () => {
  assert.throws(() => startAdapterSubprocess(opts({cudaVisibleDevices: "0,1"})),
    {code: "invalid_cuda_visible_devices"});
  assert.throws(() => startAdapterSubprocess(opts({cudaVisibleDevices: "GPU-../unsafe"})),
    {code: "invalid_cuda_visible_devices"});
});
