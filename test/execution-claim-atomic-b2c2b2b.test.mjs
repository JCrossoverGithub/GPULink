import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { SqlitePersistence } from '../src/control-plane/persistence/sqlite.mjs';
import { ControlPlaneDatabase } from '../src/control-plane/database.mjs';
import { Scheduler } from '../src/control-plane/scheduler.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {gpu,registerWorker,submitJob} from './helpers.mjs';
import {reservePersistedExecutionAttempt,ExecutionClaimDenied} from '../src/control-plane/execution-claim-authority.mjs';

const NOW=1_700_000_000_000;
const DIGEST='sha256:'+'a'.repeat(64);
async function fixture(run) {
 const dir=mkdtempSync(path.join(tmpdir(),'gpulink-b2c2b2b-'));
 const file=path.join(dir,'test.sqlite');
 const database=new SqlitePersistence(file);
 const cfg={tokens:{client:'client-test-token-long-enough-for-valid-auth-xxxxxxxx',worker:'worker-test-token-long-enough-for-valid-auth-xxxxxxxx',admin:'admin-test-token-long-enough-for-valid-auth-xxxxxxxx'},heartbeatTimeoutMs:60_000,leaseDurationMs:10_000,vramSafetyMiB:512};
 let now=NOW; const clock=()=>now;
 const scheduler=new Scheduler(database,{...cfg,clock});
 const service=new ControlPlaneService(database,scheduler,cfg,{clock});
 const ctx={database,scheduler,service,clock,advance:(ms)=>{now+=ms;return now}};
 try{await run(ctx,file);}finally{await database.close();rmSync(dir,{recursive:true,force:true})}
}
async function allocated(ctx) {
 const worker=await registerWorker(ctx,{name:'w'+Math.random().toString().slice(2),gpus:[gpu({uuid:'gpu-A',memoryTotalMiB:8192})]});
 const job=await submitJob(ctx);
 assert.equal(job.status,'leased');
 return {worker,job};
}
function claim({worker,job},overrides={}) {
 return {subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,
   workerId:worker.id,gpuUuid:job.assignedGpuUuid,attemptId:'attempt_b2c2b2b_A',
   artifactDigest:DIGEST,adapterIdentity:'adapter_A',runtimePolicyRevision:'rev_1',
   approvalRef:'approval_A',now:NOW,maxHeartbeatAgeMs:60_000,...overrides};
}
async function rejectsClaim(ctx,input,code) {
 await assert.rejects(reservePersistedExecutionAttempt(ctx.database,input),err=>err instanceof ExecutionClaimDenied && err.code===code);
}
function read(raw,table,field) {return raw.database.prepare(`SELECT * FROM ${table} ORDER BY ${field}`).all()}

test('B2C2B2B: claim first missing fence atomically, but never launch',async()=>fixture(async (ctx,file)=>{
 const a=await allocated(ctx);const result=await reservePersistedExecutionAttempt(ctx.database,claim(a));
 assert.deepEqual(result,{attemptId:'attempt_b2c2b2b_A',fenceEpoch:1,canLaunch:false});
 const raw=new ControlPlaneDatabase(file);try{
  const fences=read(raw,'gpu_resource_fences','worker_id');const attempts=read(raw,'execution_attempts','attempt_id');
  assert.equal(fences.length,1);assert.equal(attempts.length,1);
  assert.equal(fences[0].safety_state,'reserved');assert.equal(fences[0].epoch,1);
  assert.equal(fences[0].attempt_id,attempts[0].attempt_id);
  assert.equal(attempts[0].lease_id,a.job.leaseId);
 }finally{raw.close()}
}));

test('B2C2B2B: held fence blocks replay and different attempt, no second rows',async()=>fixture(async (ctx,file)=>{
 const a=await allocated(ctx);await reservePersistedExecutionAttempt(ctx.database,claim(a));
 await rejectsClaim(ctx,claim(a),'resource_held');
 await rejectsClaim(ctx,claim(a,{attemptId:'attempt_b2c2b2b_B'}),'resource_held');
 const raw=new ControlPlaneDatabase(file);try{assert.equal(read(raw,'execution_attempts','attempt_id').length,1)}finally{raw.close()}
}));

test('B2C2B2B: stale lease, expired boundary, wrong worker or GPU reject before fence insert',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);
 for (const [changes,reason] of [[{leaseId:'lease_stale'},'stale_lease'],[{workerId:'worker_false'},'worker_unavailable'],[{gpuUuid:'gpu_wrong'},'worker_unavailable'],[{now:NOW+10_000},'stale_lease']])
  await rejectsClaim(ctx,claim(a,changes),reason);
 const raw=new ControlPlaneDatabase(file);try{assert.equal(read(raw,'gpu_resource_fences','worker_id').length,0)}finally{raw.close()}
}));

test('B2C2B2B: offline and drained worker reject',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);await ctx.database.setWorkerDrain(a.worker.id,true,NOW);
 await rejectsClaim(ctx,claim(a),'worker_unavailable');
 await ctx.database.setWorkerDrain(a.worker.id,false,NOW);
 await ctx.database.transaction(t=>t.markStaleWorkersOffline(NOW+1,NOW+2));
 await rejectsClaim(ctx,claim(a),'worker_unavailable');
}));

test('B2C2B2B: two concurrent claims across serialized transactions have single winner',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);const req=claim(a);const results=await Promise.allSettled([
  reservePersistedExecutionAttempt(ctx.database,req),
  reservePersistedExecutionAttempt(ctx.database,{...req,attemptId:'attempt_second'}),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const raw=new ControlPlaneDatabase(file);try{assert.equal(read(raw,'execution_attempts','attempt_id').length,1)}finally{raw.close()}
}));

test('B2C2B2B: rollback on reused tombstone leaves original fence epoch unchanged',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);
 await reservePersistedExecutionAttempt(ctx.database,claim(a));
 const raw2=new ControlPlaneDatabase(file);try{
 raw2.database.prepare("UPDATE execution_attempts SET status='terminated' WHERE attempt_id='attempt_b2c2b2b_A'").run();
 raw2.database.prepare("UPDATE gpu_resource_fences SET safety_state='clear',subject_kind=NULL,subject_id=NULL,lease_id=NULL,attempt_id=NULL WHERE worker_id=?").run(a.worker.id);
 }finally{raw2.close()}
 await assert.rejects(reservePersistedExecutionAttempt(ctx.database,claim(a)),/UNIQUE constraint/i);
 const raw3=new ControlPlaneDatabase(file);try{
 const f=read(raw3,'gpu_resource_fences','worker_id')[0];assert.equal(f.epoch,1);assert.equal(f.safety_state,'clear');
 }finally{raw3.close()}
}));

test('B2C2B2B: explicit test-only clear yields new monotonic epoch and retained tombstone',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);await reservePersistedExecutionAttempt(ctx.database,claim(a));
 const raw=new ControlPlaneDatabase(file);try{
  raw.database.prepare("UPDATE execution_attempts SET status='terminated' WHERE attempt_id='attempt_b2c2b2b_A'").run();
  raw.database.prepare("UPDATE gpu_resource_fences SET safety_state='clear',subject_kind=NULL,subject_id=NULL,lease_id=NULL,attempt_id=NULL WHERE worker_id=?").run(a.worker.id);
 }finally{raw.close()}
 const r=await reservePersistedExecutionAttempt(ctx.database,claim(a,{attemptId:'attempt_b2c2b2b_B'}));
 assert.equal(r.fenceEpoch,2);assert.equal(r.canLaunch,false);
 const inspect=new ControlPlaneDatabase(file);try{assert.equal(read(inspect,'execution_attempts','attempt_id').length,2)}finally{inspect.close()}
}));

test('B2C2B2B: held fence blocks scheduler after logical lease expiry',async()=>fixture(async(ctx,file)=>{
 const a=await allocated(ctx);await reservePersistedExecutionAttempt(ctx.database,claim(a));
 ctx.advance(10_001);await ctx.scheduler.runOnce();
 const job=await ctx.database.getJob(a.job.id);assert.equal(job.status,'queued');
 assert.equal(job.assignedWorkerId,null);
 const next=await submitJob(ctx);assert.equal(next.status,'queued');
}));

test('B2C2B2B: malformed shape and accessor reject without evaluation',async()=>fixture(async(ctx)=>{
 const a=await allocated(ctx);let accessed=false;const x=claim(a);
 Object.defineProperty(x,'approvalRef',{enumerable:true,get(){accessed=true;throw Error('accessor')}});
 await rejectsClaim(ctx,x,'invalid_claim');assert.equal(accessed,false);
 await rejectsClaim(ctx,{...claim(a),command:'/bin/sh'},'invalid_claim');
 await rejectsClaim(ctx,claim(a,{artifactDigest:'sha256:not_a_hash'}),'invalid_claim');
}));

test('B2C2B2B: no independent launch authority or external exposed method',async()=>fixture(async(ctx)=>{
 assert.equal(typeof ctx.database.reserveExecutionAttempt,'undefined');
 const a=await allocated(ctx);const r=await reservePersistedExecutionAttempt(ctx.database,claim(a));
 assert.equal(r.canLaunch,false);
}));


test('B2C2B2B: session lease is a valid owner but not an execution grant',async()=>fixture(async(ctx,file)=>{
 const worker=await registerWorker(ctx,{name:'managed_session_worker',capabilities:['speech.streaming'],gpus:[gpu({uuid:'session_gpu',memoryTotalMiB:8192})]});
 const {session}=await ctx.service.submitSession({projectId:'project_session',capability:'speech.streaming',requirements:{minVramMiB:1000,capabilities:['speech.streaming']},recovery:{maxInterruptions:1}});
 assert.equal(session.status,'allocated');
 const req=claim({worker,job:session},{subjectKind:'session',attemptId:'session_attempt'});
 const record=await reservePersistedExecutionAttempt(ctx.database,req);
 assert.equal(record.fenceEpoch,1);assert.equal(record.canLaunch,false);
 const raw=new ControlPlaneDatabase(file);try{
   const attempt=raw.database.prepare('SELECT * FROM execution_attempts WHERE attempt_id=?').get('session_attempt');
   assert.equal(attempt.subject_kind,'session');assert.equal(attempt.project_id,'project_session');
 }finally{raw.close()}
 ctx.advance(10_001);await ctx.scheduler.runOnce();
 const recovered=await ctx.database.getSession(session.id);
 assert.equal(recovered.status,'requested');
 assert.deepEqual(await ctx.database.listBlockedGpuResources(),[{workerId:worker.id,gpuUuid:'session_gpu'}]);
}));
