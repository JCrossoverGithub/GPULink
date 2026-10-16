import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLIP_V1, encodeGlipV1, decodeGlipV1, runEchoConformance } from '../src/echo-conformance.mjs';

const repoFixture = fileURLToPath(new URL('../../../examples/external-adapter/echo-subprocess.py', import.meta.url));
const cli = fileURLToPath(new URL('../bin/conformance.mjs', import.meta.url));

function withExternalCopy(fn) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gpulink-external-adapter-'));
  try {
    const copied = path.join(directory, 'separate-adapter.py');
    writeFileSync(copied, readFileSync(repoFixture), {mode:0o600});
    return fn(copied);
  } finally { rmSync(directory, {recursive:true, force:true}); }
}

test('independent GLIP frame agrees with immutable wire bytes', () => {
  const frame = encodeGlipV1(GLIP_V1.BINARY, Buffer.from([0, 255]));
  assert.equal(frame.toString('hex'), '474c4950030000000200ff');
  assert.deepEqual(decodeGlipV1(frame), [{kind:3, payload:Buffer.from([0, 255])}]);
  assert.throws(() => encodeGlipV1(GLIP_V1.BINARY, Buffer.alloc(65_537)),
    {code:'oversize_payload'});
  assert.throws(() => decodeGlipV1(frame.subarray(0, -1)),
    {code:'truncated_payload'});
  // Golden fingerprint ensures this test vector does not get silently changed.
  assert.equal(createHash('sha256').update(frame).digest('hex'),
    'cdc7d04b82f5d24959a6adaaab3ddc0fb46acc0e8b3d97ece2c9ee60b1cf3133');
});

test('outside-repository stdlib Python echo passes profile using only package API', () => {
  const py = spawnSync('python3', ['--version'], {encoding:'utf8'});
  if (py.status !== 0) throw new Error('python3 required for cross-language conformance');
  withExternalCopy(copied => {
    assert.equal(runEchoConformance({
      executable:'python3', args:['-I', '-S', copied], timeoutMs:3000,
    }).length, 6);
  });
});

test('CLI works against external copy and rejects wrong command', () => {
  withExternalCopy(copied => {
    const positive = spawnSync(process.execPath, [cli, '--', 'python3', '-I', '-S', copied],
      {encoding:'utf8',timeout:30_000});
    assert.equal(positive.status,0,positive.stderr);
    assert.match(positive.stdout, /PASS: GLIP v1 echo profile only/);
    const negative = spawnSync(process.execPath, [cli, '--', 'does-not-exist-gpulink'],
      {encoding:'utf8',timeout:10_000});
    assert.equal(negative.status,1);
    assert.match(negative.stderr,/FAIL: process_failed_or_timed_out/);
  });
});
