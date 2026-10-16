import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {PostgresPersistence} from '../src/control-plane/persistence/postgres.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {Scheduler} from '../src/control-plane/scheduler.mjs';
import {gpu,registerWorker,submitJob} from './helpers.mjs';
import {reservePersistedExecutionAttempt,ExecutionClaimDenied} from '../src/control-plane/execution-claim-authority.mjs';
const URL=process.env.GPULINK_TEST_POSTGRES_URL;
const gate={skip:URL&&process.env.GPULINK_B2C2B2B_TEST_DB_ACK==='YES_DISPOSABLE'
  ?false:'requires disposable PG and GPULINK_B2C2B2B_TEST_DB_ACK=YES_DISPOSABLE'};
const NOW=1_700_000_000_000;
async function fixture(fn) {
 const persistence=new PostgresPersistence(URL);
 const raw=new pg.Pool({connectionString:URL,max:4});
 const config={tokens:{client:'client-test-token-long-enough-for-valid-auth-xxxxxxxx',worker:'worker-test-token-long-enough-for-valid-auth-xxxxxxxx',admin:'admin-test-token-long-enough-for-valid-auth-xxxxxxxx'},heartbeatTimeoutMs:60_000,leaseDurationMs:10_000,vramSafetyMiB:512};
 const scheduler=new Scheduler(persistence,{...config,clock:()=>NOW});
 const service=new ControlPlaneService(persistence,scheduler,config,{clock:()=>NOW});
 let worker;
 try{
  await persistence.initialize();
  const name='b2c2b2b_'+randomUUID().replaceAll('-','');
  worker=await registerWorker({service},{name,gpus:[gpu({uuid:'device_'+name,memoryTotalMiB:8192})]});
  const job=await submitJob({service});assert.equal(job.status,'leased');
  const claim={subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,workerId:worker.id,
    gpuUuid:job.assignedGpuUuid,attemptId:'attempt_'+name,
    artifactDigest:'sha256:'+'b'.repeat(64),adapterIdentity:'adapter_A',
    runtimePolicyRevision:'rev_1',approvalRef:'approved_A',now:NOW,maxHeartbeatAgeMs:60_000};
  await fn({persistence,raw,worker,job,claim,scheduler});
 }finally{
  if(worker){
   const id=worker.id;
   await raw.query('DELETE FROM execution_attempts WHERE worker_id=$1',[id]);
   await raw.query('DELETE FROM gpu_resource_fences WHERE worker_id=$1',[id]);
   await raw.query('DELETE FROM events WHERE subject_id IN (SELECT id FROM jobs WHERE assigned_worker_id=$1)',[id]);
   await raw.query('DELETE FROM jobs WHERE assigned_worker_id=$1',[id]);
   await raw.query('DELETE FROM workers WHERE id=$1',[id]);
  }
  await raw.end();await persistence.close();
 }
}

test('B2C2B2B PostgreSQL: first missing fence is atomically reserved, no launch',gate,()=>fixture(async({persistence,raw,claim})=>{
 const result=await reservePersistedExecutionAttempt(persistence,claim);
 assert.deepEqual(result,{attemptId:claim.attemptId,fenceEpoch:1,canLaunch:false});
 const fences=await raw.query('SELECT * FROM gpu_resource_fences WHERE worker_id=$1',[claim.workerId]);
 const attempts=await raw.query('SELECT * FROM execution_attempts WHERE worker_id=$1',[claim.workerId]);
 assert.equal(fences.rowCount,1);assert.equal(attempts.rowCount,1);
 assert.equal(fences.rows[0].safety_state,'reserved');
 assert.equal(attempts.rows[0].lease_id,claim.leaseId);
}));

test('B2C2B2B PostgreSQL: held fence rejects duplicate and stale lease',gate,()=>fixture(async({persistence,claim})=>{
 await reservePersistedExecutionAttempt(persistence,claim);
 await assert.rejects(reservePersistedExecutionAttempt(persistence,claim),e=>e instanceof ExecutionClaimDenied&&e.code==='resource_held');
 await assert.rejects(reservePersistedExecutionAttempt(persistence,{...claim,attemptId:'another_attempt'}),e=>e instanceof ExecutionClaimDenied&&e.code==='resource_held');
 await assert.rejects(reservePersistedExecutionAttempt(persistence,{...claim,leaseId:'stale_lease'}),e=>e instanceof ExecutionClaimDenied&&e.code==='stale_lease');
}));

test('B2C2B2B PostgreSQL: repeated identifier rolled back including epoch',gate,()=>fixture(async({persistence,raw,claim})=>{
 await reservePersistedExecutionAttempt(persistence,claim);
 await raw.query("UPDATE execution_attempts SET status='terminated' WHERE attempt_id=$1",[claim.attemptId]);
 await raw.query(`UPDATE gpu_resource_fences SET safety_state='clear',subject_kind=NULL,
  subject_id=NULL,lease_id=NULL,attempt_id=NULL WHERE worker_id=$1`,[claim.workerId]);
 await assert.rejects(reservePersistedExecutionAttempt(persistence,claim),/duplicate key|unique constraint/i);
 const res=await raw.query('SELECT epoch,safety_state FROM gpu_resource_fences WHERE worker_id=$1',[claim.workerId]);
 assert.equal(Number(res.rows[0].epoch),1);assert.equal(res.rows[0].safety_state,'clear');
}));

test('B2C2B2B PostgreSQL: independent scheduler lock fences missing rows',gate,()=>fixture(async({persistence,raw,claim})=>{
 let release;const hold=new Promise(r=>{release=r});
 let entered;const ready=new Promise(r=>{entered=r});
 const tx=persistence.transaction(async txn=>{
  assert.equal(await txn.tryAcquireSchedulerLock(),true);
  entered();await hold;
 });
 try{
  await ready;
  await assert.rejects(reservePersistedExecutionAttempt(persistence,claim),
   e=>e instanceof ExecutionClaimDenied&&e.code==='allocation_busy');
  const rows=await raw.query('SELECT * FROM gpu_resource_fences WHERE worker_id=$1',[claim.workerId]);
  assert.equal(rows.rowCount,0);
 }finally{release();await tx;}
 const result=await reservePersistedExecutionAttempt(persistence,claim);
 assert.equal(result.fenceEpoch,1);
}));

test('B2C2B2B PostgreSQL: concurrent distinct attempts permit exactly one',gate,()=>fixture(async({persistence,raw,claim})=>{
 const other=new PostgresPersistence(URL);try{
  await other.initialize();
  const outcomes=await Promise.allSettled([
   reservePersistedExecutionAttempt(persistence,claim),
   reservePersistedExecutionAttempt(other,{...claim,attemptId:'another_attempt'}),
  ]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const result=await raw.query('SELECT * FROM execution_attempts WHERE worker_id=$1',[claim.workerId]);
  assert.equal(result.rowCount,1);
 }finally{await other.close();}
}));
