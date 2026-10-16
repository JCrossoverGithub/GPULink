import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresPersistence} from '../src/control-plane/persistence/postgres.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {Scheduler} from '../src/control-plane/scheduler.mjs';
import {reserveBrokerBoundAttempt,observeBrokerBoundAttempt,parseBrokerProfiles} from '../src/control-plane/broker-claim-service.mjs';
import {gpu,registerWorker,submitJob} from './helpers.mjs';

const URL=process.env.GPULINK_TEST_POSTGRES_URL;
const gate={skip:URL && process.env.GPULINK_D1_TEST_DB_ACK==='YES_DISPOSABLE' ? false :
  'requires isolated disposable Postgres and GPULINK_D1_TEST_DB_ACK=YES_DISPOSABLE'};
const TOKEN='d1-postgres-test-only-credential-not-production';
const NOW=1_700_000_000_000;
async function fixture(callback) {
 const db=new PostgresPersistence(URL), pool=new pg.Pool({connectionString:URL,max:4});
 const config={tokens:{client:'test-client-token-abcdefghijklmnopqrstuvwxyz',worker:'test-worker-token-abcdefghijklmnopqrstuvwxyz',
   admin:'test-admin-token-abcdefghijklmnopqrstuvwxyz'},heartbeatTimeoutMs:60_000,
   leaseDurationMs:10_000,vramSafetyMiB:512};
 const scheduler=new Scheduler(db,{...config,clock:()=>NOW});
 let worker;
 try {
  await db.initialize();
  const provision=new ControlPlaneService(db,scheduler,config,{clock:()=>NOW});
  const id=randomUUID().replaceAll('-','');
  worker=await registerWorker({service:provision},{name:'d1_'+id,
    gpus:[gpu({uuid:'gpu_d1_'+id,memoryTotalMiB:8192})]});
  const job=await submitJob({service:provision});
  assert.equal(job.status,'leased');
  const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'broker_d1_'+id,
    workerId:worker.id,projectId:'test-project',token:TOKEN,
    artifactDigest:'sha256:'+'d'.repeat(64),adapterIdentity:'adapter-d1',
    runtimePolicyRevision:'reviewed-d1',approvalRef:'approval-d1'}]));
  const req={schemaVersion:1,subjectKind:'job',subjectId:job.id,
    leaseId:job.leaseId,attemptId:'d1_'+id};
  const call=(method,request=req,auth='Bearer '+TOKEN)=>
    method({persistence:db,profiles,authorization:auth,request,
      clock:()=>NOW,maxHeartbeatAgeMs:60_000});
  await callback({db,pool,worker,job,req,call});
 }finally{
  if(worker){
   const id=worker.id;
   await pool.query('DELETE FROM execution_attempts WHERE worker_id=$1',[id]);
   await pool.query('DELETE FROM gpu_resource_fences WHERE worker_id=$1',[id]);
   await pool.query('DELETE FROM events WHERE subject_id IN (SELECT id FROM jobs WHERE assigned_worker_id=$1)',[id]);
   await pool.query('DELETE FROM jobs WHERE assigned_worker_id=$1',[id]);
   await pool.query('DELETE FROM workers WHERE id=$1',[id]);
  }
  await pool.end();await db.close();
 }
}

test('D1 PostgreSQL: read-only scope, exact fence observation, and durable hold',gate,
 ()=>fixture(async({pool,worker,req,call})=>{
  const before=await call(observeBrokerBoundAttempt);
  assert.equal(before.disposition,'not_found');
  assert.equal(before.canRelease,false);
  await call(reserveBrokerBoundAttempt);
  const observed=await call(observeBrokerBoundAttempt);
  assert.deepEqual(observed,{schemaVersion:1,attemptId:req.attemptId,
    disposition:'held',fenceEpoch:1,canLaunch:false,canRelease:false,evidenceVerified:false});
  const bad=await call(observeBrokerBoundAttempt,{...req,leaseId:'substituted'});
  assert.equal(bad.disposition,'not_found');
  const wrong=await call(observeBrokerBoundAttempt,req,'Bearer not-a-valid-broker-credential').catch(e=>e);
  assert.equal(wrong.statusCode,401);
  const count=await pool.query('SELECT count(*)::integer AS n FROM execution_attempts WHERE worker_id=$1',[worker.id]);
  assert.equal(count.rows[0].n,1);
  const held=await pool.query('SELECT safety_state FROM gpu_resource_fences WHERE worker_id=$1',[worker.id]);
  assert.equal(held.rows[0].safety_state,'reserved');
 }));

test('D1 PostgreSQL: simulated lost fence linkage never becomes cleanup evidence',gate,
 ()=>fixture(async({pool,worker,req,call})=>{
  await call(reserveBrokerBoundAttempt);
  await pool.query(`UPDATE gpu_resource_fences SET safety_state='quarantined',
    attempt_id='different-attempt' WHERE worker_id=$1`,[worker.id]);
  const result=await call(observeBrokerBoundAttempt);
  assert.equal(result.disposition,'unconfirmed');
  assert.equal(result.fenceEpoch,1);
  assert.equal(result.canRelease,false);
  assert.equal(result.evidenceVerified,false);
  const hold=await pool.query('SELECT safety_state FROM gpu_resource_fences WHERE worker_id=$1',[worker.id]);
  assert.equal(hold.rows[0].safety_state,'quarantined');
 }));
