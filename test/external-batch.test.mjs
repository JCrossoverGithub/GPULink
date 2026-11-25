import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTestContext,gpu} from './helpers.mjs';
import {loadApprovedSubprocessAdapters,loadApprovedSubprocessSessionAdapters} from '../src/worker/approved-subprocess-adapters.mjs';
import {batchJson} from '../src/shared/batch-contract.mjs';
const type='external.batch.test';
const uuid='GPU-326a4232-3d30-423b-29a1-66f2d054a0d4';
const manifest={schemaVersion:2,type,adapterId:'test.batch.v1',version:'1.0.0',executionMode:'bounded-process'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const fixture=await readFile(new URL('../examples/external-adapter/echo-subprocess.py',import.meta.url),'utf8');
const probe=spawnSync(process.platform==='win32'?'python':existsSync('/usr/bin/python3')?'/usr/bin/python3':'python3',['-c','import os,sys;print(os.path.realpath(sys.executable))'],{encoding:'utf8'});
const python=probe.status===0?realpathSync(probe.stdout.trim()):null;
async function catalog(t,program=fixture) {
  const dir=await mkdtemp(path.join(tmpdir(),'gpulink-batch-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const executable=python, script=path.join(dir,'batch.py'), file=path.join(dir,'catalog.json');
  await writeFile(script,program,{mode:0o600});
  const item={manifest,command:{executable,sha256:sha(await readFile(executable)),args:['-I','-B',script],assets:[{path:script,sha256:sha(program)}]}};
  const put=items=>writeFile(file,JSON.stringify({schemaVersion:1,adapters:items}),{mode:0o600});
  await put([item]); return {file,script,item,put};
}
const job={id:'job_batch_test',type,assignedGpuUuid:uuid,payload:{hello:'world'}};
const ctx=()=>({signal:new AbortController().signal,gpu:{uuid}});
test('bounded batch GLIP returns only one JSON object after END and exit; verifies hashes again', {skip:!python},async t=>{
  const {file,script}=await catalog(t);
  const [adapter]=await loadApprovedSubprocessAdapters(file);
  assert.equal(await adapter.readinessProbe(),true);
  assert.equal(adapter.handleSession,undefined);
  assert.deepEqual(await adapter.executeJob(job,ctx()),job.payload);
  await assert.rejects(loadApprovedSubprocessSessionAdapters(file),{code:'adapter_manifest'});
  await assert.rejects(adapter.executeJob({...job,type:'different'},ctx()),{code:'batch_type_mismatch'});
  await assert.rejects(adapter.executeJob(job,{...ctx(),gpu:{uuid:'GPU-other'}}),{code:'invalid_assignment'});
  await writeFile(script,'tampered');
  assert.equal(await adapter.readinessProbe(),false);
  await assert.rejects(adapter.executeJob(job,ctx()),{code:'approved_file_hash_mismatch'});
});
test('mixed catalog is allowed but batch duplicates, streaming reserved type, and session completion mode fail closed',{skip:!python},async t=>{
  const {file,item,put}=await catalog(t);
  const streaming={...item,manifest:{...manifest,type:'example.stream',adapterId:'test.stream.v1',executionMode:'streaming-gateway'}};
  await put([item,streaming]); assert.equal((await loadApprovedSubprocessAdapters(file)).length,2);
  await put([item,{...item,manifest:{...manifest,adapterId:'duplicate'}}]); await assert.rejects(loadApprovedSubprocessAdapters(file),{code:'invalid_batch_spec'});
  await put([{...item,manifest:{...manifest,executionMode:'streaming-gateway'}}]); await assert.rejects(loadApprovedSubprocessAdapters(file),{code:'adapter_manifest'});
  await put([{...item,completionMode:'explicit-text-v1'}]); await assert.rejects(loadApprovedSubprocessAdapters(file),{code:'invalid_batch_spec'});
});
for (const [name, replacement] of [
  ['duplicate', 'send(kind, payload); send(kind, payload)'],
  ['binary', 'send(BINARY, payload)'],
  ['nonobject','send(TEXT, b"[]")'],
  ['oversize','send(TEXT, b\'{"x":"\' + b"x" * 40000 + b\'"}\')'],
  ['missing','pass'],
]) test(`batch rejects ${name} result`,{skip:!python},async t=>{
  const {file}=await catalog(t,fixture.replace('send(kind, payload)',replacement));
  const [a]=await loadApprovedSubprocessAdapters(file);
  await assert.rejects(a.executeJob(job,ctx()),{code:'execution_failed'});
});
test('batch rejects successful-looking result followed by nonzero exit',{skip:!python},async t=>{
  const normalized=fixture.replace(/\r\n/gu,'\n');
  const original='send(END)\n            return 0';
  assert.equal(normalized.split(original).length,2,'fixture must contain exactly one successful END exit');
  const broken=normalized.replace(original,'send(END)\n            return 2');
  assert.notEqual(broken,normalized,'fixture must actually exit nonzero');
  const {file}=await catalog(t,broken);
  const [a]=await loadApprovedSubprocessAdapters(file); await assert.rejects(a.executeJob(job,ctx()),{code:'execution_failed'});
});
test('batch cancellation waits for child close',{skip:!python},async t=>{
  const {file}=await catalog(t,fixture.replace('import sys','import sys\nimport time').replace('send(kind, payload)','time.sleep(30); send(kind, payload)'));
  const [a]=await loadApprovedSubprocessAdapters(file); const controller=new AbortController();
  const execution=a.executeJob(job,{signal:controller.signal,gpu:{uuid}});
  const timer=setTimeout(()=>controller.abort(),150);
  try { await assert.rejects(execution,{code:'execution_failed'}); } finally {clearTimeout(timer);}
});
test('bounded JSON counts UTF-8, rejects nonfinite and non-object values',()=>{
  assert.equal(batchJson({x:1}),' {"x":1}'.trim());
  for(const v of [[],null,{x:Infinity},{x:'é'.repeat(16384)}]) assert.throws(()=>batchJson(v));
});
test('durable placement requires exact ready bounded-process identity; persisted results bounded',async()=>{
  const c=createTestContext();
  try {
    const add=(name,manifests,health)=>c.service.registerWorker({name,version:'test',labels:{},capabilities:[type],adapterManifests:manifests,adapterHealth:health,warmModels:[],gpus:[gpu({uuid:`GPU-${name}`,memoryTotalMiB:8192})]});
    const health={schemaVersion:2,type,adapterId:manifest.adapterId,state:'ready',code:'ready',checkedAt:c.clock()};
    await add('legacy',[],[]);
    await add('stream',[{...manifest,executionMode:'streaming-gateway'}],[health]);
    const request={projectId:'batch-test',type,payload:{x:1}};
    const {job:j}=await c.service.submitJob(request);
    assert.equal(j.status,'queued');
    await assert.rejects(c.service.submitJob({...request,constraints:{capabilities:[]}}),/own capability/);
    await assert.rejects(c.service.submitJob({...request,payload:{x:'x'.repeat(32768)}}),/exceeds/);
    await assert.rejects(c.service.submitSession({projectId:'batch-test',capability:type}),/job API/);
    const w=await add('batch',[manifest],[health]);
    await c.scheduler.runOnce();
    const leased=await c.database.getJob(j.id); assert.equal(leased.assignedWorkerId,w.id);
    const lease={workerId:w.id,leaseId:leased.leaseId};
    await c.service.startJob(j.id,lease);
    await assert.rejects(c.service.finishJob(j.id,{...lease,outcome:'succeeded',result:{x:'x'.repeat(32768)}}),/exceeds/);
    await c.service.finishJob(j.id,{...lease,outcome:'succeeded',result:{x:2}});
    assert.deepEqual((await c.database.getJob(j.id)).result,{x:2});
    assert.deepEqual(await c.database.listJobCleanupHolds(),[]);
  }finally{await c.close();}
});
