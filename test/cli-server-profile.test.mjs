import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeServerOrigin, readServerSetup, runServerInit, runServerLifecycle, defaultServerSetupDirectory } from '../src/cli/server-profile.mjs';
import { createLocalSetup } from '../src/cli/local-init.mjs';
import { defaultLocalSetupDirectory } from '../src/cli/setup-directory.mjs';
const output = {log(){}, error(){}};
const linux = process.platform === 'linux';
const cli = fileURLToPath(new URL('../src/cli/main.mjs', import.meta.url));
function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gpl-server-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  return path.join(root, 'instance');
}
test('server origin is HTTPS only, without paths, credentials, queries or fragments', () => {
  assert.equal(normalizeServerOrigin('https://GPU.example.org:443/'), 'https://gpu.example.org');
  assert.equal(normalizeServerOrigin('https://127.0.0.1:8443'), 'https://127.0.0.1:8443');
  for (const bad of ['http://127.0.0.1','http://gpu.example.org','https://user:pass@gpu.example.org','https://gpu.example.org/path','https://gpu.example.org?','https://gpu.example.org#','https://gpu.example.org\\x','https://%67pu.example.org',' https://gpu.example.org']) assert.throws(() => normalizeServerOrigin(bad));
  assert.notEqual(defaultServerSetupDirectory(), defaultLocalSetupDirectory());
});
test('server init is private, non-overwriting and keeps all backend profiles loopback', {skip:!linux}, t => {
  const directory = setup(t);
  assert.equal(runServerInit(['--public-url','http://bad.example'],directory,output),1);
  assert.equal(existsSync(directory),false);
  assert.equal(runServerInit(['--public-url','https://gpu.example.org'],directory,output),0);
  const profile = readServerSetup(directory);
  assert.equal(profile.publicOrigin,'https://gpu.example.org');
  assert.equal(profile.profiles['control-plane.env'].GPULINK_CONTROL_HOST,'127.0.0.1');
  assert.equal(profile.profiles['client.env'].GPULINK_URL,'http://127.0.0.1:8088');
  assert.equal(profile.profiles['worker.env'].GPULINK_CONTROL_PLANE_URL,'http://127.0.0.1:8088');
  assert.equal(statSync(path.join(directory,'server.json')).mode & 0o777,0o600);
  assert.equal(existsSync(path.join(directory,'run')),false);
  const bytes = readFileSync(path.join(directory,'server.json'),'utf8');
  assert.equal(runServerInit(['--public-url','https://other.example'],directory,output),1);
  assert.equal(readFileSync(path.join(directory,'server.json'),'utf8'),bytes);
  writeFileSync(path.join(directory,'server.json'),'{"schemaVersion":1,"publicOrigin":"http://bad.example"}');
  assert.throws(() => readServerSetup(directory));
});
test('local and server lifecycle entry points refuse the wrong profile', {skip:!linux}, async t => {
  const directory = setup(t);
  createLocalSetup(directory);
  assert.equal(await runServerLifecycle(['start'],directory,output),1);
  assert.equal(existsSync(path.join(directory,'run')),false);
  const server = directory+'-server';
  assert.equal(runServerInit(['--public-url','https://gpu.example.org'],server,output),0);
  for (const args of [['local','start'],['local','worker','start','--accept-assigned-work'],['local','smoke','--real-gpu']]) {
    const result = spawnSync(process.execPath,[cli,'--config-dir',server,...args],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/Server profile selected/);
  }
  assert.equal(existsSync(path.join(server,'run')),false);
});
