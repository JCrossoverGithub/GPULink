/**
 * GPULink Adapter IPC v1 framing (candidate).
 * Application bytes are opaque. Does not certify consumption or model readiness.
 * This module performs NO process launching, adapter evaluation or GPU work.
 */
import { TextDecoder } from "node:util";

export const ADAPTER_IPC_MAGIC = Buffer.from("GLIP", "ascii");
export const ADAPTER_IPC_HEADER_BYTES = 9;
export const ADAPTER_IPC_MAX_FRAME_BYTES = 65_536;
export const ADAPTER_IPC_MAX_INPUT_CHUNK_BYTES = 1_048_576;
export const ADAPTER_IPC_MAX_BATCH_FRAMES = 64;
export const ADAPTER_IPC_TYPES = Object.freeze({
  HELLO: 1, READY: 2, BINARY: 3, TEXT: 4,
  END: 5, ERROR: 6, CANCEL: 7,
});
const knownTypes = new Set(Object.values(ADAPTER_IPC_TYPES));
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function frameError(code) {
  const error = new Error(`GPULink adapter IPC: ${code}`);
  error.code = code;
  return error;
}

function checkType(type) {
  if (!Number.isInteger(type) || !knownTypes.has(type)) {
    throw frameError("invalid_frame_type");
  }
}

export function encodeAdapterIpcFrame(type, payload = Buffer.alloc(0)) {
  checkType(type);
  if (!(Buffer.isBuffer(payload) || payload instanceof Uint8Array)) {
    throw frameError("invalid_payload");
  }
  if (payload.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES) {
    throw frameError("frame_too_large");
  }
  const frame = Buffer.allocUnsafe(ADAPTER_IPC_HEADER_BYTES + payload.byteLength);
  ADAPTER_IPC_MAGIC.copy(frame, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt32BE(payload.byteLength, 5);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    .copy(frame, ADAPTER_IPC_HEADER_BYTES);
  return frame;
}

export function encodeAdapterIpcJson(type, value) {
  checkType(type);
  if (![ADAPTER_IPC_TYPES.HELLO, ADAPTER_IPC_TYPES.READY,
    ADAPTER_IPC_TYPES.ERROR].includes(type)) {
    throw frameError("json_control_type_required");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw frameError("invalid_control_payload");
  }
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw frameError("invalid_control_payload");
  }
  return encodeAdapterIpcFrame(type, bytes);
}

export function decodeAdapterIpcText(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    throw frameError("invalid_payload");
  }
  try { return strictUtf8.decode(bytes); }
  catch { throw frameError("invalid_utf8"); }
}

export function decodeAdapterIpcJson(frame, expectedType) {
  if (!frame || frame.type !== expectedType ||
      ![ADAPTER_IPC_TYPES.HELLO, ADAPTER_IPC_TYPES.READY,
        ADAPTER_IPC_TYPES.ERROR].includes(expectedType)) {
    throw frameError("invalid_control_type");
  }
  let data;
  try { data = JSON.parse(decodeAdapterIpcText(frame.payload)); }
  catch { throw frameError("invalid_control_json"); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw frameError("invalid_control_json");
  }
  return data;
}

export function createAdapterIpcDecoder() {
  let header = Buffer.alloc(ADAPTER_IPC_HEADER_BYTES);
  let headerUsed = 0;
  let currentType = 0;
  let expected = 0;
  let payload = null;
  let payloadUsed = 0;
  let terminal = false;

  function fail(code) {
    terminal = true;
    throw frameError(code);
  }

  function decode(chunk) {
    if (terminal) fail("decoder_terminal");
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) fail("invalid_chunk");
    if (chunk.byteLength > ADAPTER_IPC_MAX_INPUT_CHUNK_BYTES) fail("chunk_too_large");
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames = [];
    let offset = 0;
    while (offset < input.length) {
      if (headerUsed < ADAPTER_IPC_HEADER_BYTES) {
        const take = Math.min(ADAPTER_IPC_HEADER_BYTES - headerUsed, input.length - offset);
        input.copy(header, headerUsed, offset, offset + take);
        headerUsed += take;
        offset += take;
        if (headerUsed < ADAPTER_IPC_HEADER_BYTES) break;
        if (!header.subarray(0, 4).equals(ADAPTER_IPC_MAGIC)) fail("invalid_magic");
        currentType = header.readUInt8(4);
        if (!knownTypes.has(currentType)) fail("invalid_frame_type");
        expected = header.readUInt32BE(5);
        if (expected > ADAPTER_IPC_MAX_FRAME_BYTES) fail("frame_too_large");
        payload = Buffer.alloc(expected);
        payloadUsed = 0;
      }
      if (expected > 0) {
        const take = Math.min(expected - payloadUsed, input.length - offset);
        input.copy(payload, payloadUsed, offset, offset + take);
        payloadUsed += take;
        offset += take;
      }
      if (payloadUsed === expected) {
        frames.push({ type: currentType, payload });
        if (frames.length > ADAPTER_IPC_MAX_BATCH_FRAMES) fail("frame_batch_exceeded");
        headerUsed = 0;
        currentType = 0;
        expected = 0;
        payload = null;
        payloadUsed = 0;
      }
    }
    return frames;
  }

  function finish() {
    if (terminal) fail("decoder_terminal");
    if (headerUsed !== 0) fail("truncated_frame");
    terminal = true;
  }

  return Object.freeze({ push: decode, finish });
}
