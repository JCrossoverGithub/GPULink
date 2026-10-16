import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresPersistence } from '../src/control-plane/persistence/postgres.mjs';
import { ControlPlaneService } from '../src/control-plane/service.mjs';
import { Scheduler } from '../src/control-plane/scheduler.mjs';
import { reserveBrokerBoundAttempt,parseBrokerProfiles,BrokerClaimError } from '../src/control-plane/broker-claim-service.mjs';
import { gpu,registerWorker,submitJob } from './helpers.mjs';
const URL=process.env.GPULINK_TEST_POSTGRES_URL;
const gate={skip: URL && process.env.GPULINK_B2C2B2C1_TEST_DB_ACK==='YES_DISPOSABLE'
 ? false : 'requires disposable PostgreSQL and GPULINK_B2C2B2C1_TEST_DB_ACK=YES_DISPOSABLE'};
const NOW=1_700_000_000_000;
const TOKEN='postgres-broker-token-long-and-unique-ABCDEF';
async function fixture(fn) {
 const persistence=new PostgresPersistence(URL);
 const pool=new pg.Pool({connectionString:URL,max:4});
 const config={tokens:{client:'client-test-token-long-enough-for-valid-auth-xxxxxxxx',worker:'worker-test-token-long-enough-for-valid-auth-xxxxxxxx',admin:'admin-test-token-long-enough-for-valid-auth-xxxxxxxx'},heartbeatTimeoutMs:60_000,leaseDurationMs:10_000,vramSafetyMiB:512};
 const scheduler=new Scheduler(persistence,{...config,clock:()=>NOW});
 const name='b2c2b2c1_'+randomUUID().replaceAll('-','');
 let worker;
 try {
  await persistence.initialize();
  const setupService=new ControlPlaneService(persistence,scheduler,config,{clock:()=>NOW});
  worker=await registerWorker({service:setupService},{name,gpus:[gpu({uuid:'gpu_'+name,memoryTotalMiB:8192})]});
  const job=await submitJob({service:setupService});assert.equal(job.status,'leased');
  const profiles=parseBrokerProfiles(JSON.stringify([{
    brokerId:'broker_'+name,workerId:worker.id,projectId:'test-project',token:TOKEN,
    artifactDigest:'sha256:'+'c'.repeat(64),adapterIdentity:'adapter_static',
    runtimePolicyRevision:'revision_static',approvalRef:'approval_static',
  }]));
  const claim=(attemptId='attempt_'+name)=>reserveBrokerBoundAttempt({
   persistence,profiles,authorization:'Bearer '+TOKEN,
   request:{schemaVersion:1,subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId},
   clock:()=>NOW,maxHeartbeatAgeMs:60_000,
  });
  await fn({persistence,pool,job,worker,profiles,claim});
 } finally {
  if (worker) {
   // Test database is explicitly disposable. Avoid touching any other worker.
   const id=worker.id;
   await pool.query('DELETE FROM execution_attempts WHERE worker_id=$1',[id]);
   await pool.query('DELETE FROM gpu_resource_fences WHERE worker_id=$1',[id]);
   await pool.query('DELETE FROM events WHERE subject_id IN (SELECT id FROM jobs WHERE assigned_worker_id=$1)',[id]);
   await pool.query('DELETE FROM jobs WHERE assigned_worker_id=$1',[id]);
   await pool.query('DELETE FROM workers WHERE id=$1',[id]);
  }
  await pool.end();await persistence.close();
 }
}

test('B2C2B2C1 PostgreSQL: broker profile metadata persisted, not provided by caller',gate,()=>fixture(async({pool,worker,job,claim})=>{
 const result=await claim();
 assert.deepEqual(result,{schemaVersion:1,attemptId:result.attemptId,fenceEpoch:1,status:'reserved-not-launchable',canLaunch:false});
 const data=await pool.query('SELECT * FROM execution_attempts WHERE worker_id=$1',[worker.id]);
 assert.equal(data.rowCount,1);assert.equal(data.rows[0].artifact_digest,'sha256:'+'c'.repeat(64));
 assert.equal(data.rows[0].approval_ref,'approval_static');
 assert.equal(data.rows[0].adapter_identity,'adapter_static');
 assert.equal(data.rows[0].lease_id,job.leaseId);
}));

test('B2C2B2C1 PostgreSQL: distinct connections cannot bypass an existing claim',gate,()=>fixture(async({persistence,pool,worker,job,profiles,claim})=>{
 const other=new PostgresPersistence(URL);
 try {
  await other.initialize();
  const second=()=>reserveBrokerBoundAttempt({persistence:other,profiles,
    authorization:'Bearer '+TOKEN,request:{schemaVersion:1,subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId:'alternative_'+worker.id},
    clock:()=>NOW,maxHeartbeatAgeMs:60_000});
  const results=await Promise.allSettled([claim(),second()]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.ok(results.some(r=>r.status==='rejected' && r.reason instanceof BrokerClaimError));
  const count=await pool.query('SELECT count(*)::integer AS count FROM execution_attempts WHERE worker_id=$1',[worker.id]);
  assert.equal(count.rows[0].count,1);
 }finally{await other.close();}
}));
