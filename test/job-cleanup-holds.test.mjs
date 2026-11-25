import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTestContext,gpu,registerWorker,submitJob} from './helpers.mjs';
import {SqlitePersistence} from '../src/control-plane/persistence/sqlite.mjs';
import {ControlPlaneDatabase} from '../src/control-plane/database.mjs';
import {Scheduler} from '../src/control-plane/scheduler.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';

const device='GPU-JOB-CLEANUP';
async function worker(ctx,name='worker-cleanup',uuid=device) {
  return registerWorker(ctx,{name,gpus:[gpu({uuid,memoryTotalMiB:8192})],capabilities:['diagnostic.echo','speech.streaming']});
}
async function running(ctx,w) {
  const job=await submitJob(ctx);
  assert.equal(job.assignedWorkerId,w.id);
  return ctx.service.startJob(job.id,{workerId:w.id,leaseId:job.leaseId});
}
const sessionRequest={projectId:'cleanup-test',capability:'speech.streaming',requirements:{minVramMiB:1}};

test('running cancellation persists hold, denies stale completion, blocks jobs and sessions even on re-enrollment',async()=>{
  const ctx=createTestContext();
  try {
    const w=await worker(ctx); const job=await running(ctx,w);
    assert.equal((await ctx.service.cancelJob(job.id)).status,'cancelled');
    const [hold]=await ctx.database.listJobCleanupHolds();
    assert.deepEqual(hold,{workerId:w.id,gpuUuid:device,epoch:1,jobId:job.id,leaseId:job.leaseId});
    await assert.rejects(ctx.service.finishJob(job.id,{workerId:w.id,leaseId:job.leaseId,outcome:'succeeded',result:{}}),/lease is not valid/);
    await worker(ctx,'same-device-new-identity');
    assert.equal((await submitJob(ctx)).status,'queued');
    assert.equal((await ctx.service.submitSession(sessionRequest)).session.status,'requested');
    const other=await worker(ctx,'other-physical-device','GPU-OTHER');
    assert.ok((await ctx.database.listActiveJobs()).some(j=>j.assignedWorkerId===other.id));
  } finally {await ctx.close();}
});

test('expired running job is terminal, never automatically replayed on an available different GPU',async()=>{
  const ctx=createTestContext({leaseDurationMs:1000});
  try {
    const w=await worker(ctx); const job=await running(ctx,w);
    await worker(ctx,'other-device','GPU-OTHER');
    ctx.advance(1001); await ctx.scheduler.runOnce();
    const lost=await ctx.database.getJob(job.id);
    assert.equal(lost.status,'failed'); assert.equal(lost.attempt,1);
    assert.equal(lost.error.code,'execution_cleanup_required');
    assert.equal(lost.assignedGpuUuid,device); assert.equal(lost.leaseExpiresAt,null);
    assert.equal((await ctx.database.listJobCleanupHolds()).length,1);
    await assert.rejects(ctx.service.renewJob(job.id,{workerId:w.id,leaseId:job.leaseId}),/lease is not valid/);
  } finally {await ctx.close();}
});

test('pre-start cancellation and expiry do not create holds, and pre-start expiry still retries',async()=>{
  const ctx=createTestContext({leaseDurationMs:1000});
  try {
    await worker(ctx);
    const first=await submitJob(ctx); assert.equal(first.status,'leased');
    await ctx.service.cancelJob(first.id);
    const second=await submitJob(ctx); assert.equal(second.status,'leased');
    ctx.advance(1001); await ctx.scheduler.runOnce();
    const retried=await ctx.database.getJob(second.id);
    assert.equal(retried.status,'leased');assert.equal(retried.attempt,2);
    assert.deepEqual(await ctx.database.listJobCleanupHolds(),[]);
    await assert.rejects(ctx.service.startJob(second.id,{workerId:second.assignedWorkerId,leaseId:second.leaseId}),/lease is not valid/);
  } finally {await ctx.close();}
});

test('operator recovery requires explicit confirmation, offline drained worker and exact epoch; replay cannot clear a later hold',async()=>{
  const ctx=createTestContext({heartbeatTimeoutMs:1000,leaseDurationMs:10000});
  try {
    const w=await worker(ctx); const job=await running(ctx,w);
    await ctx.service.cancelJob(job.id); const [hold]=await ctx.database.listJobCleanupHolds();
    await assert.rejects(ctx.service.releaseJobCleanupHold(hold),/confirmation/);
    await assert.rejects(ctx.service.releaseJobCleanupHold({...hold,confirmStopped:true}),/not drained\/offline/);
    await ctx.service.setWorkerDrain(w.id,{drain:true});
    ctx.advance(1001); await ctx.scheduler.runOnce();
    await assert.rejects(ctx.service.releaseJobCleanupHold({...hold,epoch:2,confirmStopped:true}),/mismatch/);
    await assert.rejects(ctx.service.releaseJobCleanupHold({...hold,leaseId:'wrong',confirmStopped:true}),/mismatch/);
    assert.deepEqual(await ctx.service.releaseJobCleanupHold({...hold,confirmStopped:true}),{released:true,operatorAttested:true});
    assert.deepEqual(await ctx.database.listJobCleanupHolds(),[]);
    await worker(ctx); await ctx.service.setWorkerDrain(w.id,{drain:false});
    const next=await running(ctx,w); await ctx.service.cancelJob(next.id);
    const [nextHold]=await ctx.database.listJobCleanupHolds(); assert.equal(nextHold.epoch,2);
    await ctx.service.setWorkerDrain(w.id,{drain:true}); ctx.advance(1001); await ctx.scheduler.runOnce();
    await assert.rejects(ctx.service.releaseJobCleanupHold({...hold,confirmStopped:true}),/mismatch/);
    assert.deepEqual(await ctx.database.listJobCleanupHolds(),[nextHold]);
    assert.equal((await ctx.database.listEventsAfter(0)).filter(e=>e.type==='job.cleanup_operator_confirmed').length,1);
  } finally {await ctx.close();}
});

test('offline running job holds survive reopen; cancellation transaction rollback leaves no partial hold',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'gpulink-job-holds-'));
  const file=path.join(dir,'state.sqlite');
  let database=new SqlitePersistence(file); let now=1700000000000;
  const clock=()=>now; const config={heartbeatTimeoutMs:1000,leaseDurationMs:100000,vramSafetyMiB:512};
  const mk=()=>{const scheduler=new Scheduler(database,{...config,clock});return {database,scheduler,service:new ControlPlaneService(database,scheduler,config,{clock})};};
  try {
    let ctx=mk();const w=await worker(ctx);const job=await running(ctx,w);
    await assert.rejects(database.transaction(async t=>{await t.cancelJob(job.id,now);throw Error('rollback');}),/rollback/);
    assert.equal((await database.getJob(job.id)).status,'running');assert.deepEqual(await database.listJobCleanupHolds(),[]);
    now+=1001;await ctx.scheduler.runOnce();assert.equal((await database.getJob(job.id)).status,'failed');
    await database.close();database=new SqlitePersistence(file);ctx=mk();
    assert.equal((await database.listJobCleanupHolds())[0].jobId,job.id);
    await worker(ctx);assert.equal((await submitJob(ctx)).status,'queued');
    // Existing fence rows are never overwritten by a running-job transition.
    const raw=new ControlPlaneDatabase(file);try {assert.equal(raw.database.prepare('SELECT safety_state FROM gpu_resource_fences').get().safety_state,'quarantined');}finally{raw.close();}
  } finally {await database.close();rmSync(dir,{recursive:true,force:true});}
});

test('running cancellation never overwrites an existing broker-owned hold',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'gpulink-existing-hold-'));
  const file=path.join(dir,'state.sqlite');const database=new SqlitePersistence(file);
  const clock=()=>1700000000000;const config={heartbeatTimeoutMs:10000,leaseDurationMs:10000,vramSafetyMiB:512};
  const scheduler=new Scheduler(database,{...config,clock});const ctx={database,scheduler,service:new ControlPlaneService(database,scheduler,config,{clock})};
  const raw=new ControlPlaneDatabase(file);
  try {
    const w=await worker(ctx);const job=await running(ctx,w);
    raw.database.prepare(`INSERT INTO gpu_resource_fences(worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,attempt_id,updated_at) VALUES(?,?,7,'reserved','job',?,?,'broker-attempt',?)`).run(w.id,device,job.id,job.leaseId,clock());
    await ctx.service.cancelJob(job.id);
    assert.equal(raw.database.prepare('SELECT epoch FROM gpu_resource_fences').get().epoch,7);
    assert.equal(raw.database.prepare('SELECT attempt_id FROM gpu_resource_fences').get().attempt_id,'broker-attempt');
    assert.deepEqual(await database.listJobCleanupHolds(),[]);
    assert.equal((await submitJob(ctx)).status,'queued');
  }finally{raw.close();await database.close();rmSync(dir,{recursive:true,force:true});}
});
