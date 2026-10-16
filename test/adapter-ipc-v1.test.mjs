import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_IPC_TYPES as T,
  ADAPTER_IPC_HEADER_BYTES,
  ADAPTER_IPC_MAX_FRAME_BYTES,
  createAdapterIpcDecoder,
  encodeAdapterIpcFrame,
  encodeAdapterIpcJson,
  decodeAdapterIpcJson,
  decodeAdapterIpcText,
} from "../src/worker/adapter-ipc-v1.mjs";

const echoPath = fileURLToPath(new URL(
  "../examples/external-adapter/echo-subprocess.py", import.meta.url,
));
const hello = {
  protocol: "gpulink.adapter.ipc", version: 1, sessionId: "example-session-1",
};
const ready = { protocol: "gpulink.adapter.ipc", version: 1, ready: true };

function decodeAll(bytes) {
  const decoder = createAdapterIpcDecoder();
  const frames = decoder.push(bytes);
  decoder.finish();
  return frames;
}

function python(input) {
  const result = spawnSync("python3", ["-I", "-S", echoPath], {
    input, timeout: 3_000, maxBuffer: 131_072,
    env: { LANG: "C", LC_ALL: "C" },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

test("IPC header is stable, big-endian and opaque binary survives roundtrip", () => {
  const bytes = Buffer.from([0, 255, 1, 2, 0, 66]);
  const framed = encodeAdapterIpcFrame(T.BINARY, bytes);
  assert.equal(framed.subarray(0, 4).toString("ascii"), "GLIP");
  assert.equal(framed[4], T.BINARY);
  assert.equal(framed.readUInt32BE(5), bytes.length);
  assert.equal(framed.length, ADAPTER_IPC_HEADER_BYTES + bytes.length);
  const [actual] = decodeAll(framed);
  assert.equal(actual.type, T.BINARY);
  assert.deepEqual(actual.payload, bytes);
});

test("decoder handles fragmentation at every possible byte boundary", () => {
  const payload = Buffer.from("hello echo", "utf8");
  const framed = encodeAdapterIpcFrame(T.TEXT, payload);
  for (let split = 0; split <= framed.length; split++) {
    const decoder = createAdapterIpcDecoder();
    const frames = [
      ...decoder.push(framed.subarray(0, split)),
      ...decoder.push(framed.subarray(split)),
    ];
    decoder.finish();
    assert.equal(frames.length, 1);
    assert.equal(decodeAdapterIpcText(frames[0].payload), "hello echo");
  }
});

test("coalesced frames retain original order", () => {
  const wire = Buffer.concat([
    encodeAdapterIpcFrame(T.BINARY, Buffer.from([5])),
    encodeAdapterIpcFrame(T.TEXT, Buffer.from("abc")),
    encodeAdapterIpcFrame(T.END),
  ]);
  assert.deepEqual(decodeAll(wire).map((f) => f.type), [T.BINARY, T.TEXT, T.END]);
});

test("maximum payload is accepted, one extra byte is rejected", () => {
  assert.equal(decodeAll(encodeAdapterIpcFrame(
    T.BINARY, Buffer.alloc(ADAPTER_IPC_MAX_FRAME_BYTES),
  ))[0].payload.length, ADAPTER_IPC_MAX_FRAME_BYTES);
  assert.throws(() => encodeAdapterIpcFrame(
    T.BINARY, Buffer.alloc(ADAPTER_IPC_MAX_FRAME_BYTES + 1),
  ), { code: "frame_too_large" });
});

test("malformed magic, direction kind and declared length fail closed", () => {
  const good = encodeAdapterIpcFrame(T.TEXT, Buffer.from("ok"));
  const magic = Buffer.from(good); magic[0] = 0;
  assert.throws(() => decodeAll(magic), { code: "invalid_magic" });
  const kind = Buffer.from(good); kind[4] = 99;
  assert.throws(() => decodeAll(kind), { code: "invalid_frame_type" });
  const size = Buffer.from(good); size.writeUInt32BE(65_537, 5);
  assert.throws(() => decodeAll(size), { code: "frame_too_large" });
});

test("truncated header or payload fails closed at EOF", () => {
  const complete = encodeAdapterIpcFrame(T.BINARY, Buffer.from([1, 2, 3]));
  for (let len = 1; len < complete.length; len++) {
    const decoder = createAdapterIpcDecoder();
    decoder.push(complete.subarray(0, len));
    assert.throws(() => decoder.finish(), { code: "truncated_frame" });
    assert.throws(() => decoder.push(complete), { code: "decoder_terminal" });
  }
});

test("invalid UTF-8 is rejected without substitution", () => {
  assert.throws(() => decodeAdapterIpcText(Buffer.from([0xff])), { code: "invalid_utf8" });
  assert.throws(() => decodeAdapterIpcJson({ type: T.READY, payload: Buffer.from([0xff]) }, T.READY),
    { code: "invalid_control_json" });
});

test("control JSON is restricted to control frame kinds and JSON objects", () => {
  assert.deepEqual(decodeAdapterIpcJson(decodeAll(
    encodeAdapterIpcJson(T.HELLO, hello),
  )[0], T.HELLO), hello);
  assert.throws(() => encodeAdapterIpcJson(T.BINARY, hello), { code: "json_control_type_required" });
  assert.throws(() => encodeAdapterIpcJson(T.READY, [1]), { code: "invalid_control_payload" });
});

test("batch of excessive zero-size frames and giant input chunk fail closed", () => {
  const unit = encodeAdapterIpcFrame(T.END);
  const decoder = createAdapterIpcDecoder();
  assert.throws(() => decoder.push(Buffer.concat(Array(65).fill(unit))),
    { code: "frame_batch_exceeded" });
  assert.throws(() => createAdapterIpcDecoder().push(Buffer.alloc(1_048_577)),
    { code: "chunk_too_large" });
});

test("language-neutral Python echo accepts HELLO, binary, text, END without credentials", () => {
  const binary = Buffer.from([0, 1, 255, 0, 42]);
  const text = Buffer.from("こんにちは  IPC", "utf8");
  const input = Buffer.concat([
    encodeAdapterIpcJson(T.HELLO, hello),
    encodeAdapterIpcFrame(T.BINARY, binary),
    encodeAdapterIpcFrame(T.TEXT, text),
    encodeAdapterIpcFrame(T.END),
  ]);
  const result = python(input);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.length, 0);
  const frames = decodeAll(result.stdout);
  assert.deepEqual(frames.map((f) => f.type), [T.READY, T.BINARY, T.TEXT, T.END]);
  assert.deepEqual(decodeAdapterIpcJson(frames[0], T.READY), ready);
  assert.deepEqual(frames[1].payload, binary);
  assert.deepEqual(frames[2].payload, text);
  assert.equal(frames[3].payload.length, 0);
  assert.ok(input.length < 65_536);
});

test("Python fixture rejects malformed startup and invalid post-handshake direction", () => {
  const noHello = python(encodeAdapterIpcFrame(T.TEXT, Buffer.from("oops")));
  assert.equal(noHello.status, 2);
  assert.equal(noHello.stdout.length, 0);
  assert.equal(noHello.stderr.length, 0);
  const wrongDirection = python(Buffer.concat([
    encodeAdapterIpcJson(T.HELLO, hello),
    encodeAdapterIpcJson(T.READY, ready),
  ]));
  assert.equal(wrongDirection.status, 2);
  assert.deepEqual(decodeAll(wrongDirection.stdout).map(f => f.type), [T.READY]);
});

test("Python fixture honors cancellation without treating it as success", () => {
  const result = python(Buffer.concat([
    encodeAdapterIpcJson(T.HELLO, hello),
    encodeAdapterIpcFrame(T.CANCEL),
  ]));
  assert.equal(result.status, 0);
  assert.deepEqual(decodeAll(result.stdout).map(f => f.type), [T.READY]);
});

test("Python fixture treats abrupt input EOF as incomplete, never success", () => {
  const result = python(Buffer.concat([
    encodeAdapterIpcJson(T.HELLO, hello),
    encodeAdapterIpcFrame(T.BINARY, Buffer.from([1, 2])),
  ]));
  assert.equal(result.status, 2);
  assert.deepEqual(decodeAll(result.stdout).map(f => f.type), [T.READY, T.BINARY]);
});
