import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readLocalSmokeSetup } from './local-smoke.mjs';
import { installationFingerprint, observeLinuxBirth, validateOwnershipRecord } from './local-process-ownership.mjs';

const ROLED = 'control-plane';
const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 8088;
const MAX_RECORD_BYTES = 4096;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const managedScript = path.join(root, 'src/cli/local-managed-supervisor.mjs');
const controlScript = path.join(root, 'src/control-plane/main.mjs');

function assertLinux() {
  if (process.platform !== 'linux') throw new Error('Local persistent lifecycle preview currently requires Linux (including WSL). No Windows process-control authority is granted.');
}
function privateDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Unsafe local run directory (must be a private real directory).');
}
function paths(setup) {
  const directory = path.join(setup.directory, 'run');
  const socket = path.join(directory, 'control-plane.sock');
  if (Buffer.byteLength(socket) >= 100) throw new Error('Local setup path is too long for a safe Unix control socket.');
  return { directory, socket, record: path.join(directory, 'control-plane.owner.json'), lock: path.join(directory, 'start.lock') };
}
function readOwnedRecord(setup) {
  const { directory, record } = paths(setup);
  privateDirectory(directory);
  const first = lstatSync(record);
  if (!first.isFile() || first.isSymbolicLink() || first.size > MAX_RECORD_BYTES || (first.mode & 0o077) !== 0)
    throw new Error('Unsafe managed process record.');
  const fd = openSync(record, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let value;
  try {
    const second = fstatSync(fd);
    if (!second.isFile() || second.dev !== first.dev || second.ino !== first.ino || second.size > MAX_RECORD_BYTES || (second.mode & 0o077) !== 0)
      throw new Error('Managed process record changed during inspection.');
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('Oversized managed process record.');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
  if (!validateOwnershipRecord(value, setup, ROLED)) throw new Error('Invalid installation-bound process record.');
  const birth = observeLinuxBirth(value.pid);
  if (!birth || birth.bootId !== value.birth.bootId || birth.startTicks !== value.birth.startTicks)
    throw new Error('Managed process birth cannot be verified (missing or stale).');
  return value;
}
// Capture kernel file identity; neither a matching filename nor a socket type
// authorizes cleanup of a path another process may have substituted.
export function sameRuntimeEntry(original, current) {
  return Boolean(original && current && original.dev === current.dev &&
    original.ino === current.ino && original.mode === current.mode);
}
function socketSafe(socketPath) {
  const st = lstatSync(socketPath);
  if (!st.isSocket() || st.isSymbolicLink()) throw new Error('Unsafe managed IPC socket.');
}
function rpc(socketPath, request, timeoutMs = 1600) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let text = '';
    let settled = false;
    function finish(error, reply) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(reply);
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('Managed local IPC timed out.')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (buf) => {
      text += buf.toString('utf8');
      if (text.length > 2048) return finish(new Error('Oversized local IPC reply.'));
      const idx = text.indexOf('\n');
      if (idx < 0) return;
      try { finish(null, JSON.parse(text.slice(0, idx))); }
      catch { finish(new Error('Malformed local IPC response.')); }
    });
    socket.once('end', () => finish(new Error('Incomplete local IPC response.')));
  });
}
function verifiedReply(reply, record) {
  return reply && reply.schemaVersion === 1 && reply.role === ROLED &&
    reply.launchId === record.launchId && reply.pid === record.pid &&
    ['starting', 'ready', 'stopping'].includes(reply.state);
}
async function inspectManaged(setup) {
  assertLinux();
  const owner = readOwnedRecord(setup);
  const { socket } = paths(setup);
  socketSafe(socket);
  const reply = await rpc(socket, { op: 'status', launchId: owner.launchId });
  if (!verifiedReply(reply, owner)) throw new Error('Managed endpoint identity disagrees with the process record.');
  // Check the kernel identity a second time after the socket roundtrip.
  const birth = observeLinuxBirth(owner.pid);
  if (!birth || birth.bootId !== owner.birth.bootId || birth.startTicks !== owner.birth.startTicks)
    throw new Error('Managed process identity changed during inspection.');
  return { record: owner, state: reply.state };
}
export async function inspectManagedLocal(setup) {
  if (process.platform !== 'linux') return null;
  try { return (await inspectManaged(setup)).state; }
  catch { return null; }
}
function prepareStart(setup) {
  const p = paths(setup);
  if (!existsSync(p.directory)) mkdirSync(p.directory, { mode: 0o700 });
  privateDirectory(p.directory);
  if (existsSync(p.record) || existsSync(p.socket))
    throw new Error('Existing process record or socket; refuse to replace it. Inspect status and reconcile manually if stale.');
  // Exclusive directory lock prevents competing starts; stale lock is deliberately not stolen.
  mkdirSync(p.lock, { mode: 0o700 });
  return p;
}
function cleanSupervisorEnvironment() {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR'];
  const environment = {};
  for (const key of keep) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
export async function runLocalStart(args, directory, { output = console } = {}) {
  if (args.length !== 0) { output.error('Usage: gpulink [--config-dir DIRECTORY] local start'); return 2; }
  if (!directory) { output.error('No local installation selected.'); return 1; }
  let lock;
  try {
    assertLinux();
    const setup = readLocalSmokeSetup(directory);
    const p = prepareStart(setup);
    lock = p.lock;
    const launchId = randomBytes(32).toString('hex');
    const child = spawn(process.execPath, [managedScript, setup.directory, launchId], {
      cwd: setup.directory, env: cleanSupervisorEnvironment(), stdio: 'ignore', detached: true,
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 22_000;
    while (Date.now() < deadline) {
      if (existsSync(p.record)) {
        try {
          const inspected = await inspectManaged(setup);
          if (inspected.record.launchId !== launchId || inspected.record.pid !== child.pid)
            throw new Error('Unexpected supervisor identity; no process authority granted.');
          if (inspected.state === 'ready') {
            output.log('PASS: installation-owned local control plane started (Linux preview; no GPU worker started).');
            return 0;
          }
          if (inspected.state === 'stopping') throw new Error('Supervisor exited during startup.');
        } catch (error) {
          if (error.message.startsWith('Unexpected supervisor')) throw error;
        }
      }
      await delay(125);
    }
    throw new Error('Managed service did not become ready; inspect its private run records. No PID was signaled.');
  } catch (error) { output.error(`Local start refused: ${error.message}`); return 1; }
  finally { if (lock) { try { rmdirSync(lock); } catch { /* preserve unexpected lock state */ } } }
}
export async function runLocalStop(args, directory, { output = console } = {}) {
  if (args.length !== 0) { output.error('Usage: gpulink [--config-dir DIRECTORY] local stop'); return 2; }
  if (!directory) { output.error('No local installation selected.'); return 1; }
  let lock;
  try {
    assertLinux();
    const setup = readLocalSmokeSetup(directory);
    const p = paths(setup);
    // The same exclusive operation lock is used by start AND stop. Never
    // steal a stale lock or continue while another lifecycle operation runs.
    privateDirectory(p.directory);
    mkdirSync(p.lock, { mode: 0o700 });
    lock = p.lock;
    // Never kill a PID read from a file. Ask a verified local supervisor to stop its own child.
    const observed = await inspectManaged(setup);
    const reply = await rpc(p.socket, { op: 'stop', launchId: observed.record.launchId }, 1800);
    if (!verifiedReply(reply, observed.record) || reply.state !== 'stopping')
      throw new Error('Supervisor did not acknowledge shutdown.');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (!existsSync(p.record) && !existsSync(p.socket)) {
        output.log('PASS: managed local control plane stopped gracefully; SQLite preserved.');
        return 0;
      }
      await delay(125);
    }
    throw new Error('Graceful shutdown has not completed; no unverified process was signaled.');
  } catch (error) { output.error(`Local stop refused: ${error.message}`); return 1; }
  finally {
    // Only release the directory we successfully created, never a
    // conflicting preexisting lock owned by another command.
    if (lock) { try { rmdirSync(lock); } catch { /* preserve unexpected lock state */ } }
  }
}

// Supervisor is a separate, installation-owned process. Only IT holds a direct child handle.
// The socket is local-only and directory permission-scoped; this is not a remote auth protocol.
export async function runManagedSupervisor(args) {
  assertLinux();
  if (args.length !== 2 || !/^[a-f0-9]{64}$/u.test(args[1])) throw new Error('Invalid internal supervisor arguments.');
  const setup = readLocalSmokeSetup(args[0]);
  const launchId = args[1];
  const p = paths(setup);
  privateDirectory(p.directory);
  if (existsSync(p.record) || existsSync(p.socket)) throw new Error('Managed runtime already has an identity record or socket.');
  const birth = observeLinuxBirth(process.pid);
  if (!birth) throw new Error('Linux kernel process identity unavailable.');
  const record = {
    schemaVersion: 1, role: ROLED, installationFingerprint: installationFingerprint(setup),
    pid: process.pid, birth: { kind: 'linux-procfs', ...birth }, launchId,
  };
  let service;
  let ownedSocketStat;
  let ownedRecordStat;
  let state = 'starting';
  let exiting = false;
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    let input = '';
    socket.setTimeout(1800, () => socket.destroy());
    socket.on('data', (buf) => {
      input += buf.toString('utf8');
      if (input.length > 1024) { socket.destroy(); return; }
      const index = input.indexOf('\n');
      if (index < 0) return;
      let query;
      try { query = JSON.parse(input.slice(0, index)); } catch { socket.destroy(); return; }
      if (!query || query.launchId !== launchId || !['status', 'stop'].includes(query.op)) {
        socket.destroy(); return;
      }
      if (query.op === 'stop') {
        if (state === 'ready' || state === 'starting') {
          state = 'stopping';
          // Signal only the direct child from spawn(); never a record-supplied PID.
          if (service && service.exitCode === null) service.kill('SIGTERM');
        }
      }
      socket.end(`${JSON.stringify({ schemaVersion: 1, role: ROLED, pid: process.pid, launchId, state })}\n`);
    });
  });
  function safeCleanup() {
    try {
      const current = lstatSync(p.record);
      if (current.isFile() && !current.isSymbolicLink() &&
          sameRuntimeEntry(ownedRecordStat, current)) {
        const bytes = readFileSync(p.record, 'utf8');
        if (JSON.parse(bytes).launchId === launchId) unlinkSync(p.record);
      }
    } catch { /* preserve unknown or substituted record */ }
    try {
      const current = lstatSync(p.socket);
      if (current.isSocket() && !current.isSymbolicLink() &&
          sameRuntimeEntry(ownedSocketStat, current)) unlinkSync(p.socket);
    } catch { /* preserve unknown or substituted socket */ }
  }
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    state = 'stopping';
    server.close();
    safeCleanup();
  }
  function shutdown() {
    if (exiting) return;
    exiting = true;
    state = 'stopping';
    if (service && service.exitCode === null && service.signalCode === null) {
      service.kill('SIGTERM');
      // Never discard the ownership record before the direct child exits.
    } else {
      finish();
    }
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.on('error', () => { process.exitCode = 1; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p.socket, () => { server.removeListener('error', reject); resolve(); });
  });
  // Ensure the socket is private, independent of process umask.
  const { chmodSync } = await import('node:fs');
  try {
    chmodSync(p.socket, 0o600);
    ownedSocketStat = lstatSync(p.socket);
    if (!ownedSocketStat.isSocket() || ownedSocketStat.isSymbolicLink())
      throw new Error('Managed socket identity changed during startup.');
    const fd = openSync(p.record, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      ownedRecordStat = fstatSync(fd);
    } finally { closeSync(fd); }
  } catch (error) {
    finish();
    throw error;
  }
  const profile = setup.profiles['control-plane.env'];
  const keep = cleanSupervisorEnvironment();
  try {
    service = spawn(process.execPath, [controlScript], {
      cwd: setup.directory, env: { ...keep, ...profile }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    service.stderr.resume();
    let buffer = '';
    service.stdout.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16_384) buffer = buffer.slice(-8192);
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === 'control_plane_started' &&
              message.address === CONTROL_HOST && message.port === CONTROL_PORT) {
            const response = await fetch(`http://${CONTROL_HOST}:${CONTROL_PORT}/readyz`, {
              signal: AbortSignal.timeout(1600),
            }).catch(() => null);
            if (response?.ok && state === 'starting') state = 'ready';
          }
        } catch { /* no log echo or secret disclosure */ }
      }
    });
    service.on('error', () => { state = 'stopping'; });
    service.once('close', () => { finish(); });
  } catch (error) { shutdown(); throw error; }
  // A failed startup must not leave an indefinitely orphaned supervisor.
  setTimeout(() => {
    if (state === 'starting') shutdown();
  }, 20_000).unref();
}
