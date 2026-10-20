import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalSetup } from '../src/cli/local-init.mjs';
import { runLocalStart, runLocalStop, inspectManagedLocal } from '../src/cli/local-lifecycle.mjs';
import { readLocalSmokeSetup } from '../src/cli/local-smoke.mjs';

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
