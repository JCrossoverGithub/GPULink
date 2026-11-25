import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalSetup } from '../src/cli/local-init.mjs';
import { readRemoteWorkerSetup, runWorkerBundle, runWorkerEnrollment, runWorkerCommand } from '../src/cli/remote-worker-profile.mjs';
import { installationFingerprint } from '../src/cli/local-process-ownership.mjs';
const linux=process.platform==='linux';
const output={log(){},error(){}};
const cli=fileURLToPath(new URL('../src/cli/main.mjs',import.meta.url));
function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'gpl-w-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const server=path.join(root,'s');
  createLocalSetup(server,{publicOrigin:'https://gpu.example.org'});
  const bundle=path.join(root,'bundle.json');
  assert.equal(runWorkerBundle(['--output',bundle],server,output),0);
  return {root,server,bundle};
}
test('worker-only private bundle, independent non-overwriting worker identities and no processes', {skip:!linux},t=>{
  const {root,server,bundle}=fixture(t);
  assert.equal(statSync(bundle).mode & 0o777,0o600);
  const grant=JSON.parse(readFileSync(bundle,'utf8'));
  assert.deepEqual(Object.keys(grant).sort(),['publicOrigin','schemaVersion','workerToken']);
  assert.equal(grant.publicOrigin,'https://gpu.example.org');
  assert.equal(runWorkerBundle(['--output',bundle],server,output),1);
  const a=path.join(root,'a'),b=path.join(root,'b');
  assert.equal(runWorkerEnrollment(['--bundle',bundle],a,output),0);
  assert.equal(runWorkerEnrollment(['--bundle',bundle],b,output),0);
  const first=readRemoteWorkerSetup(a),second=readRemoteWorkerSetup(b);
  assert.notEqual(first.profiles['worker.env'].GPULINK_WORKER_NAME,second.profiles['worker.env'].GPULINK_WORKER_NAME);
  assert.notEqual(installationFingerprint(first),installationFingerprint(second));
  assert.equal(installationFingerprint(first),installationFingerprint(readRemoteWorkerSetup(a)));
  assert.equal(first.profiles['worker.env'].GPULINK_WORKER_TOKEN===grant.workerToken,true);
  assert.deepEqual(Object.keys(first.profiles),['worker.env']);
  assert.equal(first.profiles['worker.env'].GPULINK_WORKER_CAPABILITIES,'diagnostic.echo,diagnostic.gpu-status');
  assert.equal(existsSync(path.join(a,'run')),false);
  assert.equal(statSync(path.join(a,'remote-worker.json')).mode & 0o777,0o600);
  assert.equal(runWorkerEnrollment(['--bundle',bundle],a,output),1);
  assert.equal(installationFingerprint(first),installationFingerprint(readRemoteWorkerSetup(a)));
});
test('refuse unsafe bundle files, plaintext origins, secret-bearing extra fields and private key CA input', {skip:!linux},t=>{
  const {root,bundle}=fixture(t),dest=path.join(root,'w');
  chmodSync(bundle,0o644);
  assert.equal(runWorkerEnrollment(['--bundle',bundle],dest,output),1);
  chmodSync(bundle,0o600);
  const link=path.join(root,'link'); symlinkSync(bundle,link);
  assert.equal(runWorkerEnrollment(['--bundle',link],dest,output),1);
  const grant=JSON.parse(readFileSync(bundle,'utf8'));
  for(const bad of [{...grant,publicOrigin:'http://127.0.0.1'}, {...grant,adminToken:'not-allowed'}, {...grant,workerToken:['0'.repeat(64)]}]) {
    writeFileSync(bundle,JSON.stringify(bad));
    assert.equal(runWorkerEnrollment(['--bundle',bundle],dest,output),1);
  }
  writeFileSync(bundle,JSON.stringify(grant));
  const key=path.join(root,'private.pem');writeFileSync(key,'-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n');
  assert.equal(runWorkerEnrollment(['--bundle',bundle,'--ca-file',key],dest,output),1);
  assert.equal(existsSync(dest),false);
});
test('remote worker requires assignment consent, stops only verified owned process, and refuses local commands', {skip:!linux},async t=>{
  const {root,bundle}=fixture(t),dest=path.join(root,'w');
  assert.equal(runWorkerEnrollment(['--bundle',bundle],dest,output),0);
  assert.equal(await runWorkerCommand(['start'],dest,output),2);
  assert.equal(await runWorkerCommand(['stop'],dest,output),1);
  let result;
  assert.equal(await runWorkerCommand(['status'],dest,{log:line=>result=JSON.parse(line),error(){}}),0);
  assert.equal(result.managedState,'not-running');
  for (const args of [['local','start'],['server','start'],['jobs']]) {
    assert.equal(spawnSync(process.execPath,[cli,'--config-dir',dest,...args],{encoding:'utf8',timeout:5000}).status,1);
  }
  assert.equal(existsSync(path.join(dest,'run')),false);
});
