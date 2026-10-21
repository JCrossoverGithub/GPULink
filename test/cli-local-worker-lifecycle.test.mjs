import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalSetup } from '../src/cli/local-init.mjs';
import { runLocalWorkerStart, runLocalWorkerStop, runLocalStop, inspectManagedLocal } from '../src/cli/local-lifecycle.mjs';
import { readLocalSmokeSetup } from '../src/cli/local-smoke.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gpulink-worker-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'installation');
  createLocalSetup(dir);
  const messages = [];
  return { root, dir, messages, output: { log(v) { messages.push(v); }, error(v) { messages.push(v); } } };
}
test('worker start requires explicit assignment-execution consent', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalWorkerStart([], f.dir, { output: f.output }), 2);
  assert.equal(await runLocalWorkerStart(['--gpu'], f.dir, { output: f.output }), 2);
  assert.equal(await runLocalWorkerStart(['--accept-assigned-work', '--force'], f.dir, { output: f.output }), 2);
  assert.match(f.messages.join(' '), /already-queued assignments/u);
  assert.equal(existsSync(path.join(f.dir, 'run')), false);
});
test('worker start refuses when no local installation is selected', async () => {
  const output = { log(){}, error(){} };
  assert.equal(await runLocalWorkerStart(['--accept-assigned-work'], null, { output }), 1);
});
test('worker start with explicit consent still refuses an unowned control plane', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalWorkerStart(['--accept-assigned-work'], f.dir, { output:f.output }), 1);
  assert.equal(existsSync(path.join(f.dir, 'run', 'worker.owner.json')), false);
  assert.equal(existsSync(path.join(f.dir, 'run', 'worker.sock')), false);
});
test('worker stop refuses to act on an absent supervisor', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalWorkerStop([], f.dir, { output:f.output }), 1);
});
test('worker stop rejects unknown options before touching state', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalWorkerStop(['--force'], f.dir, { output:f.output }), 2);
  assert.equal(existsSync(path.join(f.dir, 'run')), false);
});
test('worker records cannot be interpreted as control-plane ownership', async (t) => {
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode:0o700 });
  const workerFile = path.join(run, 'worker.owner.json');
  writeFileSync(workerFile, 'untrusted', { mode:0o600 });
  assert.equal(await runLocalStop([], f.dir, { output:f.output }), 1);
  assert.equal(readFileSync(workerFile, 'utf8'), 'untrusted');
  assert.equal(await inspectManagedLocal(readLocalSmokeSetup(f.dir), 'worker'), null);
});
test('worker stop refuses a competing operation lock without stealing it', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only lock test');
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode:0o700 });
  const lock = path.join(run, 'start.lock');
  mkdirSync(lock, { mode:0o700 });
  assert.equal(await runLocalWorkerStop([], f.dir, { output:f.output }), 1);
  assert.equal(lstatSync(lock).isDirectory(), true);
});
test('control-plane start rejects a dangling worker record rather than adopting an orphan', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows lifecycle itself refuses to start');
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode:0o700 });
  symlinkSync(path.join(f.root, 'missing'), path.join(run, 'worker.owner.json'));
  const { runLocalStart } = await import('../src/cli/local-lifecycle.mjs');
  assert.equal(await runLocalStart([], f.dir, { output:f.output }), 1);
  assert.equal(existsSync(path.join(run, 'control-plane.owner.json')), false);
});
test('worker and control-plane status remain unverified without live IPC', async (t) => {
  const f = fixture(t);
  const setup = readLocalSmokeSetup(f.dir);
  assert.equal(await inspectManagedLocal(setup), null);
  assert.equal(await inspectManagedLocal(setup, 'worker'), null);
});
