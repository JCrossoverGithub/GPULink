import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalSetup } from '../src/cli/local-init.mjs';
import { runLocalStart, runLocalStop, inspectManagedLocal, sameRuntimeEntry } from '../src/cli/local-lifecycle.mjs';
import { readLocalSmokeSetup } from '../src/cli/local-smoke.mjs';
import { installationFingerprint, observeLinuxBirth } from '../src/cli/local-process-ownership.mjs';

function fixture(t) {
  const top = mkdtempSync(path.join(os.tmpdir(), 'gpulink-local-lifecycle-unit-'));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const dir = path.join(top, 'instance');
  createLocalSetup(dir);
  return { top, dir, log: {log(){},error(){}} };
}
test('local start and stop require an explicitly selected installation', async () => {
  const o = { log(){}, error(){} };
  assert.equal(await runLocalStart([], null, { output:o }), 1);
  assert.equal(await runLocalStop([], null, { output:o }), 1);
});
test('local start and stop reject unsupported arguments without side effects', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalStart(['--gpu'], f.dir, { output:f.log }), 2);
  assert.equal(await runLocalStop(['--force'], f.dir, { output:f.log }), 2);
  assert.equal(await inspectManagedLocal(readLocalSmokeSetup(f.dir)), null);
});
test('local stop with no identity never signals an arbitrary PID', async (t) => {
  const f = fixture(t);
  assert.equal(await runLocalStop([], f.dir, { output:f.log }), 1);
});
test('start fails closed on preexisting ownership record and does not replace it', async (t) => {
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode:0o700 });
  const record = path.join(run, 'control-plane.owner.json');
  writeFileSync(record, 'untrusted', { mode:0o600 });
  assert.equal(await runLocalStart([], f.dir, { output:f.log }), 1);
  assert.equal(readFileSync(record, 'utf8'), 'untrusted');
});
test('start refuses a symlinked runtime directory', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows symlink privileges differ; lifecycle itself fails closed.');
  const f = fixture(t);
  const elsewhere = path.join(f.top, 'elsewhere');
  mkdirSync(elsewhere, { mode:0o700 });
  symlinkSync(elsewhere, path.join(f.dir, 'run'));
  assert.equal(await runLocalStart([], f.dir, { output:f.log }), 1);
});
test('start refuses a preexisting lock and leaves it intact', async (t) => {
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode:0o700 });
  mkdirSync(path.join(run, 'start.lock'), { mode:0o700 });
  assert.equal(await runLocalStart([], f.dir, { output:f.log }), 1);
  assert.equal(readLocalSmokeSetup(f.dir).directory, f.dir);
});
test('start refuses mutated local configuration before any process is launched', async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'client.env'), 'invalid\n', { mode:0o600 });
  assert.equal(await runLocalStart([], f.dir, { output:f.log }), 1);
});
test('status does not claim a managed identity from absent runtime files', async (t) => {
  const f = fixture(t);
  assert.equal(await inspectManagedLocal(readLocalSmokeSetup(f.dir)), null);
});

test('stop uses the exclusive lifecycle lock and does not steal another operation lock', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only lifecycle lock contention; unsupported platforms refuse before lock acquisition.');
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode: 0o700 });
  const lock = path.join(run, 'start.lock');
  mkdirSync(lock, { mode: 0o700 });
  const errors = [];
  assert.equal(await runLocalStop([], f.dir, { output: { log(){}, error(m){ errors.push(m); } } }), 1);
  assert.equal(lstatSync(lock).isDirectory(), true);
  assert.match(errors.join(' '), /EEXIST/u);
});
test('unsupported platforms refuse local stop before touching an existing operation lock', async (t) => {
  if (process.platform === 'linux') return t.skip('Linux lifecycle lock contention is tested separately.');
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, { mode: 0o700 });
  const lock = path.join(run, 'start.lock');
  mkdirSync(lock, { mode: 0o700 });
  const errors = [];
  assert.equal(await runLocalStop([], f.dir, { output: { log(){}, error(m){ errors.push(m); } } }), 1);
  assert.match(errors.join(' '), /requires Linux/u);
  assert.equal(lstatSync(lock).isDirectory(), true);
});
test('stop releases only its own operation lock after refused verification', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only lifecycle');
  const f = fixture(t);
  mkdirSync(path.join(f.dir, 'run'), { mode:0o700 });
  assert.equal(await runLocalStop([], f.dir, {output:f.log}), 1);
  assert.equal(existsSync(path.join(f.dir, 'run', 'start.lock')), false);
});
test('matching live PID without its supervisor IPC cannot authorize stop', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only lifecycle');
  const f = fixture(t);
  const run = path.join(f.dir, 'run');
  mkdirSync(run, {mode:0o700});
  const birth = observeLinuxBirth(process.pid);
  assert.ok(birth);
  const setup = readLocalSmokeSetup(f.dir);
  const record = { schemaVersion: 1, role: 'control-plane',
    installationFingerprint: installationFingerprint(setup), pid:process.pid,
    birth:{kind:'linux-procfs',...birth}, launchId:'a'.repeat(64) };
  const file = path.join(run, 'control-plane.owner.json');
  writeFileSync(file, `${JSON.stringify(record)}\n`, {mode:0o600});
  assert.equal(await runLocalStop([], f.dir, {output:f.log}), 1);
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(record)}\n`);
  assert.equal(existsSync(path.join(run,'start.lock')), false);
  process.kill(process.pid,0); // observation only: no termination authority
});
test('runtime identity requires the same inode, device AND mode', () => {
  const original = {dev:5,ino:11,mode:0o140600};
  assert.equal(sameRuntimeEntry(original,{...original}),true);
  assert.equal(sameRuntimeEntry(original,{...original,ino:12}),false);
  assert.equal(sameRuntimeEntry(original,{...original,dev:6}),false);
  assert.equal(sameRuntimeEntry(original,{...original,mode:0o100600}),false);
  assert.equal(sameRuntimeEntry(null,original),false);
});
