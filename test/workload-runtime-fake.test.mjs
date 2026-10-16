import test from 'node:test';
import assert from 'node:assert/strict';
import {selectWorkloadRuntime} from '../src/worker/workload-runtime-contract.mjs';
import {createFakeWorkloadRuntime} from '../src/worker/workload-runtime-fake.mjs';
const artifact={adapterId:'example.echo',version:'1.0.0',sha256:'c'.repeat(64)};
const report=id=>({schemaVersion:1,runtimeId:id,kind:'trusted-process',availability:'available',
  verification:'simulated',supportedIpcVersions:[1],isolationProperties:[]});
const policy=id=>({schemaVersion:1,approvedArtifacts:[{artifact,trustClass:'operator-trusted'}],enabledRuntimeIds:[id],
  trustedProcessEnabled:true,allowSimulation:true});
const admission=(id,attemptId='a1',leaseId='lease1') => selectWorkloadRuntime({
  request:{schemaVersion:1,attemptId,sessionId:'session1',leaseId,artifact,requiredIpcVersion:1,requiredIsolation:[]},
  policy:policy(id),runtimeReports:[report(id)],
});
const code=name=>err=>err?.code===name;

test('fake runtime reports only simulated capability, no process created',async()=>{
  const {runtime}=createFakeWorkloadRuntime({report:report('fake-a')});
  const r=await runtime.inspect();assert.equal(r.verification,'simulated');
  assert.equal(r.kind,'trusted-process');
});
test('fake runtime cannot misrepresent operator verification',()=>{
  assert.throws(()=>createFakeWorkloadRuntime({report:{...report('fake-a'),verification:'operator-verified'}}),
    code('fake_must_be_simulated'));
});
test('fake lifecycle prepare start exit dispose with exact identity',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a')});
  const prepared=await runtime.prepare(admission('fake-a'));
  const handle=await runtime.start(prepared);
  const exited=handle.waitForExit();
  controller.exit('a1',0);
  assert.deepEqual(await exited,{exitCode:0,signal:null});
  assert.equal(handle.attemptId,'a1');
  await handle.dispose(); await handle.dispose(); await handle.terminate('after exit');
  assert.deepEqual(controller.snapshots(),[{attemptId:'a1',leaseId:'lease1',state:'disposed',cleaned:true}]);
});
test('process exit 0 is not a GPULink session success ACK',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a')});
  const h=await runtime.start(await runtime.prepare(admission('fake-a')));
  controller.exit('a1',0);
  const outcome=await h.waitForExit();
  assert.deepEqual(Object.keys(outcome).sort(),['exitCode','signal']);
  assert.equal('completed' in h,false);
});
test('termination is bounded, repeatable and not success',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a')});
  const h=await runtime.start(await runtime.prepare(admission('fake-a')));
  await Promise.all([h.terminate('lease-revoked'),h.terminate('duplicate'),h.dispose()]);
  assert.deepEqual(await h.waitForExit(),{exitCode:null,signal:'TERMINATED'});
  assert.equal(controller.snapshots()[0].cleaned,true);
});
test('prepare disposal before start prevents launch',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a')});
  const p=await runtime.prepare(admission('fake-a'));await p.dispose();await p.dispose();
  await assert.rejects(runtime.start(p),code('invalid_prepared_workload'));
  assert.equal(controller.snapshots()[0].cleaned,true);
});
test('duplicate attempt IDs cannot launch twice, even after disposed',async()=>{
  const {runtime}=createFakeWorkloadRuntime({report:report('fake-a')});
  const p=await runtime.prepare(admission('fake-a'));await p.dispose();
  await assert.rejects(runtime.prepare(admission('fake-a')),code('duplicate_attempt'));
});
test('the same prepared ticket cannot be started twice',async()=>{
  const {runtime}=createFakeWorkloadRuntime({report:report('fake-a')});
  const p=await runtime.prepare(admission('fake-a'));const h=await runtime.start(p);
  await assert.rejects(runtime.start(p),code('invalid_prepared_workload'));await h.dispose();
});
test('start failure disposes prepared resource',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a'),failStart:true});
  const p=await runtime.prepare(admission('fake-a'));
  await assert.rejects(runtime.start(p),code('fake_start_failed'));
  assert.equal(controller.snapshots()[0].cleaned,true);
});
test('prepare failure never creates a live resource',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a'),failPrepare:true});
  await assert.rejects(runtime.prepare(admission('fake-a')),code('fake_prepare_failed'));
  assert.deepEqual(controller.snapshots(),[]);
});
test('reconcile cleans orphan attempts while preserving active ones',async()=>{
  const {runtime,controller}=createFakeWorkloadRuntime({report:report('fake-a')});
  const h1=await runtime.start(await runtime.prepare(admission('fake-a','a1')));
  const h2=await runtime.start(await runtime.prepare(admission('fake-a','a2','lease2')));
  await runtime.reconcile(new Set(['a2']));
  assert.deepEqual(await h1.waitForExit(),{exitCode:null,signal:'RECONCILED'});
  assert.deepEqual(controller.snapshots().map(s=>s.cleaned),[true,false]);
  await h2.dispose();
});
test('conformance behavior independent of fake runtime identifier',async()=>{
  for(const id of ['fake-a','fake-b']) {
    const {runtime}=createFakeWorkloadRuntime({report:report(id)});
    const h=await runtime.start(await runtime.prepare(admission(id)));
    await h.terminate('test');await h.dispose();
    assert.deepEqual(await h.waitForExit(),{exitCode:null,signal:'TERMINATED'});
  }
});
test('runtime rejects forged admission tokens and incorrect backend',async()=>{
  const {runtime}=createFakeWorkloadRuntime({report:report('fake-a')});
  await assert.rejects(runtime.prepare({...admission('fake-a')}),code('invalid_runtime_admission'));
  await assert.rejects(runtime.prepare(admission('fake-b')),code('invalid_runtime_admission'));
});
test('unavailable runtime cannot prepare',async()=>{
  const unavailable={...report('fake-a'),availability:'unavailable'};
  const {runtime}=createFakeWorkloadRuntime({report:unavailable});
  await assert.rejects(runtime.prepare(admission('fake-a')),code('runtime_unavailable'));
});
