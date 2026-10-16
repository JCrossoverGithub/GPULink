/**
 * DP3C2B candidate: operator-approved subprocess-backed session adapters.
 * These programs are trusted by the operator. This is NOT an OS sandbox.
 * In particular, same-UID subprocesses may inspect worker-owned resources.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ADAPTER_IPC_TYPES, decodeAdapterIpcText } from './adapter-ipc-v1.mjs';
import { startAdapterSubprocess } from './adapter-subprocess-supervisor.mjs';
import { validateAdapterManifest } from '../shared/adapter-manifest.mjs';

const CAT_LIMIT = 65_536;
const ASSET_LIMIT = 4 * 1024 * 1024;
const EXEC_LIMIT = 64 * 1024 * 1024;
const MAX_BACKLOG = 262_144;
const MAX_REPLY_BUFFER = 262_144;
// Exact reserved text is opt-in per operator-approved adapter. No parsing or
// control interpretation occurs for existing (opaque) adapters.
export const SUBPROCESS_END_TEXT_V1 = '{"type":"gpulink.session.end.v1"}';
export const SUBPROCESS_COMPLETED_TEXT_V1 = '{"type":"gpulink.session.completed.v1"}';
const END_BYTES = Buffer.from(SUBPROCESS_END_TEXT_V1, 'utf8');
const COMPLETED_BYTES = Buffer.from(SUBPROCESS_COMPLETED_TEXT_V1, 'utf8');
const COMPLETION_MODE = 'explicit-text-v1';
const HASH = /^[a-f0-9]{64}$/u;
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v, keys) => isRecord(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const isAbsolute = v => typeof v === 'string' && v.length > 0 &&
  v.length <= 4096 && !v.includes('\0') && path.isAbsolute(v);
function bad(code) { const e = new Error(`Approved subprocess adapter: ${code}`); e.code = code; return e; }

async function verifiedFile(file, sha, limit) {
  if (!isAbsolute(file) || !HASH.test(sha)) throw bad('invalid_approved_file');
  // O_NOFOLLOW rejects leaf symlinks. Operator must also protect directories.
  let fd;
  try { fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw bad('approved_file_unavailable'); }
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw bad('approved_file_invalid');
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if (stat.mode & 0o022 || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) {
        throw bad('approved_file_permissions');
      }
    }
    const bytes = await fd.readFile();
    if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== sha) {
      throw bad('approved_file_hash_mismatch');
    }
    return bytes;
  } finally { await fd.close(); }
}

function validateCatalog(value) {
  if (!sameKeys(value, ['schemaVersion', 'adapters']) || value.schemaVersion !== 1 ||
    !Array.isArray(value.adapters) || value.adapters.length > 64) throw bad('catalog_schema');
  const identities = new Set();
  for (const item of value.adapters) {
    if (!sameKeys(item, ['manifest', 'command']) &&
        !sameKeys(item, ['manifest', 'command', 'completionMode'])) {
      throw bad('adapter_spec_schema');
    }
    if (item.completionMode !== undefined && item.completionMode !== COMPLETION_MODE) {
      throw bad('unsupported_completion_mode');
    }
    const m = validateAdapterManifest(item.manifest, 'approved subprocess adapter');
    if (m.schemaVersion !== 2 || m.executionMode !== 'streaming-gateway') throw bad('adapter_manifest');
    if (identities.has(m.adapterId)) throw bad('duplicate_adapter_id');
    identities.add(m.adapterId);
    const c = item.command;
    if (!sameKeys(c, ['executable', 'sha256', 'args', 'assets']) ||
      !isAbsolute(c.executable) || !HASH.test(c.sha256) ||
      !Array.isArray(c.args) || c.args.length > 16 ||
      c.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0') ||
        (!path.isAbsolute(a) && !/^-[A-Za-z0-9-]{1,16}$/u.test(a))) ||
      !Array.isArray(c.assets) || c.assets.length > 16 ||
      c.assets.some(a => !sameKeys(a, ['path', 'sha256']) ||
        !isAbsolute(a.path) || !HASH.test(a.sha256))) throw bad('approved_command');
    const paths = [c.executable, ...c.assets.map(a => a.path)];
    if (new Set(paths).size !== paths.length) throw bad('duplicate_approved_file');
    // A script/module path supplied as an argument must be an approved asset.
    for (const arg of c.args) {
      if (path.isAbsolute(arg) && !paths.includes(arg)) throw bad('unapproved_absolute_argument');
    }
  }
  return value.adapters;
}

async function verifyCommand(command) {
  // Verify all approved artifacts before returning any adapter as ready.
  await verifiedFile(command.executable, command.sha256, EXEC_LIMIT);
  for (const asset of command.assets) await verifiedFile(asset.path, asset.sha256, ASSET_LIMIT);
}

/** Returns standard sessionAdapters; no client-controlled executable selection. */
export async function loadApprovedSubprocessSessionAdapters(catalogPath = null) {
  if (catalogPath === null) return [];
  // Catalog needs path and ownership protection just as its approved assets do.
  if (!isAbsolute(catalogPath)) throw bad('absolute_catalog_required');
  let fd;
  try { fd = await open(catalogPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw bad('catalog_unavailable'); }
  let bytes;
  try {
    const s = await fd.stat();
    if (!s.isFile() || s.size < 1 || s.size > CAT_LIMIT ||
        (process.platform !== 'win32' && ((s.mode & 0o022) ||
         (process.getuid?.() !== undefined && s.uid !== process.getuid() && s.uid !== 0)))) {
      throw bad('catalog_permissions_or_size');
    }
    bytes = await fd.readFile();
    if (bytes.length !== s.size) throw bad('catalog_changed');
  } finally { await fd.close(); }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { throw bad('invalid_catalog_json'); }
  const specs = validateCatalog(parsed);
  // Verify every command before exposing any adapter to the worker.
  for (const item of specs) await verifyCommand(item.command);
  return specs.map(({manifest, command, completionMode}) => Object.freeze({
    manifest: Object.freeze({...manifest}),
    async readinessProbe() {
      try { await verifyCommand(command); return true; } catch { return false; }
    },
    async handleSession(session, context) {
      return bridgeSubprocessSession(session, context, command, completionMode);
    },
  }));
}

/**
 * Generic byte bridge with an optional explicit, opt-in end-of-stream control.
 * `explicit-text-v1` reserves one exact UTF-8 text payload for END and emits a
 * distinct completion acknowledgment ONLY after subprocess END ACK + exit 0.
 * No other text or binary payload is interpreted by GPULink.
 * Abrupt disconnect, lease cancellation, stderr/output failure, and missing END
 * never result in a successful completion signal.
 */
export async function bridgeSubprocessSession(
  session, {signal, dataPlaneSocket: socket}, command, completionMode = undefined,
) {
  if (!session || typeof session.id !== 'string' ||
      !signal || typeof signal.addEventListener !== 'function' ||
      !socket || typeof socket.on !== 'function' ||
      (completionMode !== undefined && completionMode !== COMPLETION_MODE)) {
    throw bad('invalid_session_context');
  }
  if (signal.aborted || socket.readyState !== 1) throw bad('session_not_connected');
  const control = new AbortController();
  let ready = false;
  let queue = [];
  let queuedBytes = 0;
  let pumping = false;
  let child = null;
  let endRequested = false;
  let graceful = false;
  let failure = null;
  let closedResolve;
  let completedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const finished = new Promise(resolve => { completedResolve = resolve; });
  const abort = () => {
    if (!control.signal.aborted) control.abort();
    closedResolve();
  };
  const onSocketClose = () => abort();
  const onSocketError = () => abort();
  const onParentAbort = () => abort();

  async function sendCompletionAck() {
    if (control.signal.aborted || socket.readyState !== 1) throw bad('completion_disconnected');
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      function settle(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control.signal.removeEventListener('abort', cancelled);
        if (err) reject(err); else resolve();
      }
      const cancelled = () => settle(bad('completion_disconnected'));
      control.signal.addEventListener('abort', cancelled, {once:true});
      timer = setTimeout(() => settle(bad('completion_ack_timeout')), 2_000);
      try {
        socket.send(COMPLETED_BYTES, {binary:false}, err => {
          if (err || control.signal.aborted) settle(bad('completion_ack_failed'));
          else settle(null);
        });
      } catch { settle(bad('completion_ack_failed')); }
      if (control.signal.aborted) cancelled();
    });
  }

  async function pump() {
    if (!ready || !child || pumping || control.signal.aborted) return;
    pumping = true;
    try {
      while (queue.length && !control.signal.aborted) {
        const item = queue.shift();
        queuedBytes -= item.data.length + 9;
        if (item.end) {
          // Previous frames have finished writing in order. This alone does
          // not prove consumption; only the child's END ACK + exit 0 can.
          await child.end();
          if (control.signal.aborted) return;
          await sendCompletionAck();
          if (control.signal.aborted) return;
          graceful = true;
          completedResolve();
          return;
        }
        if (item.binary) await child.sendBinary(item.data);
        else await child.sendText(decodeAdapterIpcText(item.data));
      }
    } catch (err) {
      if (!control.signal.aborted) {
        failure = bad(typeof err?.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(err.code)
          ? err.code : 'adapter_session_failed');
      }
      abort();
    } finally { pumping = false; }
  }

  function onMessage(data, binary) {
    if (control.signal.aborted) return;
    // Never infer successful completion from socket closure or arbitrary text.
    if (endRequested) { abort(); return; }
    let bytes;
    try { bytes = Buffer.from(data); }
    catch { abort(); return; }
    if (bytes.length > 65_536 || queuedBytes + bytes.length + 9 > MAX_BACKLOG) {
      abort(); return;
    }
    // Reserved completion responses must not be smuggled back as arbitrary
    // client text; only the worker itself is allowed to emit that response.
    if (completionMode === COMPLETION_MODE && !binary &&
        bytes.equals(COMPLETED_BYTES)) { abort(); return; }
    const end = completionMode === COMPLETION_MODE && !binary &&
      bytes.equals(END_BYTES);
    if (end) endRequested = true;
    queuedBytes += bytes.length + 9;
    queue.push({data: bytes, binary, end});
    void pump();
  }

  socket.on('message', onMessage);
  socket.once('close', onSocketClose);
  socket.once('error', onSocketError);
  signal.addEventListener('abort', onParentAbort, {once:true});
  if (signal.aborted) abort();
  try {
    await verifyCommand(command);
    if (control.signal.aborted) return;
    child = startAdapterSubprocess({
      executable: command.executable, args: command.args, sessionId: session.id,
      signal: control.signal,
      onFrame(frame) {
        if (control.signal.aborted || socket.readyState !== 1) { abort(); return; }
        // Do not allow a subprocess to forge a worker-issued completion ACK.
        if (completionMode === COMPLETION_MODE && frame.type === ADAPTER_IPC_TYPES.TEXT &&
            frame.payload.equals(COMPLETED_BYTES)) { abort(); return; }
        if (socket.bufferedAmount + frame.payload.byteLength > MAX_REPLY_BUFFER) {
          abort(); return;
        }
        try {
          socket.send(frame.payload, {binary: frame.type === ADAPTER_IPC_TYPES.BINARY}, err => {
            if (err) abort();
          });
        } catch { abort(); }
      },
    });
    // A child that exits on its own must not leave the bridge waiting on a
    // nonexistent client END or be counted as success.
    void child.completed.then(() => {
      if (!endRequested && !control.signal.aborted) abort();
    }, err => {
      if (!control.signal.aborted) {
        failure = bad(typeof err?.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(err.code)
          ? err.code : 'adapter_session_failed');
        abort();
      }
    });
    await child.ready;
    ready = true;
    void pump();
    await Promise.race([closed, finished]);
  } catch (err) {
    if (!control.signal.aborted) {
      failure = bad(typeof err?.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(err.code)
        ? err.code : 'adapter_session_failed');
    }
    abort();
  } finally {
    abort();
    if (child && !graceful) child.cancel();
    socket.removeListener('message', onMessage);
    socket.removeListener('close', onSocketClose);
    socket.removeListener('error', onSocketError);
    signal.removeEventListener('abort', onParentAbort);
    queue = []; queuedBytes = 0;
    if (child) await child.completed.catch(() => {});
  }
  if (failure && !signal.aborted) throw failure;
}
