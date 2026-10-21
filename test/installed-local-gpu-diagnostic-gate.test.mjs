import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/acceptance/installed-local-gpu-diagnostic.sh');
const source = readFileSync(script, 'utf8');

test('real-GPU acceptance is explicitly opt-in and outside unattended CI', () => {
  assert.match(source, /GPULINK_E2E_DIAGNOSTIC_ACK:-/u);
  assert.match(source, /YES_ALLOW_ONE_BOUNDED_GPU_DIAGNOSTIC/u);
  assert.match(source, /exit 2/u);
  assert.match(source, /local worker start --accept-assigned-work/u);
  assert.equal((source.match(/\bsubmit-diagnostic 256\b/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /\bsubmit-benchmark\b|\bnpm publish\b|\baws (?:deploy|cloudformation)\b/iu);
});

test('acceptance is independent of developer machine and GPU model', () => {
  assert.match(source, /BASH_SOURCE\[0\]/u);
  assert.match(source, /nvidia-smi -L/u);
  assert.match(source, /Node\.js 24\+/u);
  assert.doesNotMatch(source, /JPCMAIN|RTX 3090|MAINPC|\/mnt\/c\/Users\//iu);
  assert.match(source, /gpulink-cli-\$VERSION\.tgz/u);
});

test('acceptance preserves uncertain ownership instead of signaling PID', () => {
  assert.match(source, /local worker stop/u);
  assert.match(source, /local stop/u);
  assert.match(source, /start\.lock/u);
  assert.match(source, /worker\.owner\.json/u);
  assert.match(source, /control-plane\.owner\.json/u);
  assert.match(source, /INCOMPLETE: Temporary installation preserved/u);
  assert.match(source, /PASSED" == 1/u);
  assert.doesNotMatch(source, /\bkill\s+-|\bpkill\b|\bkillall\b|\bsudo\b/iu);
});

test('acceptance verifies authoritative GPU assignment and durable result', () => {
  assert.match(source, /ready-managed-local/gu);
  assert.match(source, /assignedGpuUuid/u);
  assert.match(source, /result\['gpu'\]\.get\('uuid'\)/u);
  assert.match(source, /job "\$JOB_ID"/u);
  assert.match(source, /control-plane\.sqlite/u);
  assert.match(source, /len\(jobs\) == 1/u);
});

test('bash syntax validates on Linux; real GPU gate remains opt-in', (t) => {
  if (process.platform !== 'linux') return t.skip('Bash acceptance gate is Linux-only');
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('missing consent fails before accessing GPU or creating installation', (t) => {
  if (process.platform !== 'linux') return t.skip('Bash acceptance gate is Linux-only');
  const env = { ...process.env };
  delete env.GPULINK_E2E_DIAGNOSTIC_ACK;
  const result = spawnSync('bash', [script], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /REFUSED: Real worker startup/u);
  assert.doesNotMatch(result.stdout, /Fresh local setup|Build and install/u);
});

test('incorrect consent fails closed without starting services', (t) => {
  if (process.platform !== 'linux') return t.skip('Bash acceptance gate is Linux-only');
  const result = spawnSync('bash', [script], {
    encoding: 'utf8', env: { ...process.env, GPULINK_E2E_DIAGNOSTIC_ACK: 'YES' }, timeout: 10_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /REFUSED: Real worker startup/u);
});
