/**
 * Developer-only, external-process conformance profile for the accepted GLIP v1
 * Python echo fixture. No GPULink worker or scheduler imports. This checks one
 * *example profile*, not general GPU/model correctness or a secure sandbox.
 * Running a developer-supplied executable runs trusted code on this machine.
 */
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

export const GLIP_V1 = Object.freeze({
  HELLO: 1, READY: 2, BINARY: 3, TEXT: 4, END: 5, ERROR: 6, CANCEL: 7,
});
const MAGIC = Buffer.from('GLIP', 'ascii');
const HEADER = 9;
const MAX_PAYLOAD = 65_536;
const MAX_OUTPUT = 262_144;
const textDecoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
const HELLO = Object.freeze({protocol:'gpulink.adapter.ipc', version:1, sessionId:'external-echo-v1'});

export class EchoConformanceError extends Error {
  constructor(code) { super(`echo-v1 conformance: ${code}`); this.code = code; }
}
function check(ok, code) { if (!ok) throw new EchoConformanceError(code); }

export function encodeGlipV1(type, payload = Buffer.alloc(0)) {
  check(Number.isInteger(type) && type >= 1 && type <= 7, 'invalid_frame_kind');
  check(Buffer.isBuffer(payload) || payload instanceof Uint8Array, 'invalid_payload');
  check(payload.byteLength <= MAX_PAYLOAD, 'oversize_payload');
  const frame = Buffer.alloc(HEADER + payload.byteLength);
  MAGIC.copy(frame, 0);
  frame[4] = type;
  frame.writeUInt32BE(payload.byteLength, 5);
  Buffer.from(payload).copy(frame, HEADER);
  return frame;
}

function control(type, body) {
  return encodeGlipV1(type, Buffer.from(JSON.stringify(body), 'utf8'));
}

export function decodeGlipV1(bytes) {
  check(Buffer.isBuffer(bytes), 'invalid_output');
  check(bytes.byteLength <= MAX_OUTPUT, 'oversize_output');
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    check(bytes.length - offset >= HEADER, 'truncated_header');
    check(bytes.subarray(offset, offset + 4).equals(MAGIC), 'invalid_magic');
    const kind = bytes[offset + 4];
    const size = bytes.readUInt32BE(offset + 5);
    check(kind >= 1 && kind <= 7, 'invalid_frame_kind');
    check(size <= MAX_PAYLOAD, 'oversize_payload');
    offset += HEADER;
    check(bytes.length - offset >= size, 'truncated_payload');
    const payload = bytes.subarray(offset, offset + size);
    if (kind === GLIP_V1.TEXT) {
      try { textDecoder.decode(payload); } catch { throw new EchoConformanceError('invalid_utf8_text'); }
    }
    frames.push({kind, payload});
    check(frames.length <= 64, 'too_many_output_frames');
    offset += size;
  }
  return frames;
}

function assertReady(frame) {
  check(frame?.kind === GLIP_V1.READY, 'missing_ready');
  let actual;
  try { actual = JSON.parse(textDecoder.decode(frame.payload)); }
  catch { throw new EchoConformanceError('invalid_ready_json'); }
  check(actual !== null && typeof actual === 'object' && !Array.isArray(actual), 'invalid_ready_json');
  check(Object.keys(actual).sort().join(',') === 'protocol,ready,version' &&
    actual.protocol === 'gpulink.adapter.ipc' && actual.version === 1 && actual.ready === true,
  'invalid_ready_schema');
}

function run(executable, args, input, timeoutMs) {
  // This is an author-side test tool, NOT operator approval. Never accept a
  // client-supplied executable; the user invokes it directly on trusted code.
  const result = spawnSync(executable, args, {
    input, timeout: timeoutMs, maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { LANG: 'C', LC_ALL: 'C' },
  });
  check(!result.error && result.signal === null && Number.isInteger(result.status),
    'process_failed_or_timed_out');
  check(Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr), 'invalid_process_output');
  return {status: result.status, frames: decodeGlipV1(result.stdout)};
}

/**
 * Runs the existing echo-v1 fixture profile against a supplied external process.
 * Requirements are intentionally limited to the *echo* protocol example.
 * Returns case names on success; throws bounded diagnostic codes on failure.
 */
export function runEchoConformance({executable, args = [], timeoutMs = 3_000}) {
  check(typeof executable === 'string' && executable.length > 0 &&
    Array.isArray(args) && args.every(a => typeof a === 'string') &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30_000,
  'invalid_options');
  const binary = Buffer.from([0, 1, 255, 0, 42]);
  const unicode = Buffer.from('GPULink-π-字幕', 'utf8');
  const first = run(executable, args, Buffer.concat([
    control(GLIP_V1.HELLO, HELLO),
    encodeGlipV1(GLIP_V1.BINARY, binary),
    encodeGlipV1(GLIP_V1.TEXT, unicode),
    encodeGlipV1(GLIP_V1.END),
  ]), timeoutMs);
  check(first.status === 0, 'happy_exit');
  check(first.frames.length === 4, 'happy_frame_count');
  assertReady(first.frames[0]);
  check(first.frames[1].kind === GLIP_V1.BINARY && first.frames[1].payload.equals(binary), 'binary_echo');
  check(first.frames[2].kind === GLIP_V1.TEXT && first.frames[2].payload.equals(unicode), 'text_echo');
  check(first.frames[3].kind === GLIP_V1.END && first.frames[3].payload.length === 0,
    'missing_end_ack');

  const wrong = run(executable, args,
    encodeGlipV1(GLIP_V1.TEXT, Buffer.from('not-a-hello')), timeoutMs);
  check(wrong.status !== 0 && wrong.frames.length === 0, 'reject_missing_hello');

  const incompatible = run(executable, args,
    control(GLIP_V1.HELLO, {...HELLO, version: 2}), timeoutMs);
  check(incompatible.status !== 0 && incompatible.frames.length === 0, 'reject_wrong_version');

  const missingEnd = run(executable, args, Buffer.concat([
    control(GLIP_V1.HELLO, HELLO), encodeGlipV1(GLIP_V1.BINARY, binary),
  ]), timeoutMs);
  check(missingEnd.status !== 0 && missingEnd.frames.length === 2, 'eof_not_failure');
  assertReady(missingEnd.frames[0]);
  check(missingEnd.frames[1].kind === GLIP_V1.BINARY &&
    missingEnd.frames[1].payload.equals(binary), 'eof_binary_echo');

  const cancelled = run(executable, args, Buffer.concat([
    control(GLIP_V1.HELLO, HELLO), encodeGlipV1(GLIP_V1.CANCEL),
  ]), timeoutMs);
  check(cancelled.frames.length === 1, 'cancel_not_terminal');
  assertReady(cancelled.frames[0]);
  // A zero exit on CANCEL is not an END ACK or a successful GPU session.

  return Object.freeze([
    'opaque binary and unicode text',
    'explicit END acknowledgement',
    'missing HELLO rejected',
    'unsupported IPC version rejected',
    'EOF without END rejected',
    'CANCEL never becomes completion',
  ]);
}
