import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresPersistence } from '../src/control-plane/persistence/postgres.mjs';
import { ControlPlaneService } from '../src/control-plane/service.mjs';
import { Scheduler } from '../src/control-plane/scheduler.mjs';
import { gpu, registerWorker, submitJob } from './helpers.mjs';

const url = process.env.GPULINK_TEST_POSTGRES_URL;
const ack = process.env.GPULINK_B2C2B2A_TEST_DB_ACK === 'YES_DISPOSABLE';
const pgGate = { skip: url && ack ? false :
  'requires GPULINK_TEST_POSTGRES_URL and GPULINK_B2C2B2A_TEST_DB_ACK=YES_DISPOSABLE' };

async function fixture(fn) {
  const persistence = new PostgresPersistence(url);
  const raw = new pg.Pool({connectionString:url,max:3});
  const name = `b2c2b2a_${randomUUID().replaceAll('-','')}`;
  const config = {
    tokens: {
      client: 'client-test-token-long-enough-for-valid-auth-xxxxxxxx',
      worker: 'worker-test-token-long-enough-for-valid-auth-xxxxxxxx',
      admin: 'admin-test-token-long-enough-for-valid-auth-xxxxxxxx',
    }, heartbeatTimeoutMs:60_000,leaseDurationMs:10_000,vramSafetyMiB:512,
  };
  const now = 1_700_000_000_000;
  const scheduler = new Scheduler(persistence,{...config,clock:()=>now});
  const service = new ControlPlaneService(persistence,scheduler,config,{clock:()=>now});
  let workerId;
  try {
    await persistence.initialize();
    const w=await registerWorker({service},{name,gpus:[gpu({uuid:'pg-gpu-'+name,memoryTotalMiB:8192})]});
    workerId=w.id;
    await fn({persistence,scheduler,service,raw,worker:w,uuid:'pg-gpu-'+name});
  } finally {
    // The disposable gate owns the whole database. Only remove this test's rows.
    if(workerId) {
      await raw.query('DELETE FROM execution_attempts WHERE worker_id=$1',[workerId]);
      await raw.query('DELETE FROM gpu_resource_fences WHERE worker_id=$1',[workerId]);
      await raw.query('DELETE FROM events WHERE subject_id IN (SELECT id FROM jobs WHERE assigned_worker_id=$1)',[workerId]);
      await raw.query('DELETE FROM jobs WHERE assigned_worker_id=$1',[workerId]);
      await raw.query('DELETE FROM workers WHERE id=$1',[workerId]);
    }
    await raw.end(); await persistence.close();
  }
}

test('B2C2B2A PostgreSQL: held fence excludes GPU and cleared fence permits placement',pgGate,async()=>{
  await fixture(async ({persistence,scheduler,service,raw,worker,uuid})=>{
    await raw.query(`INSERT INTO gpu_resource_fences
      (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at)
      VALUES ($1,$2,1,'quarantined','job','fixture','fixture-lease',1)`,[worker.id,uuid]);
    assert.deepEqual(await persistence.transaction(t=>t.listBlockedGpuResources()),[{workerId:worker.id,gpuUuid:uuid}]);
    const job=await submitJob({service});
    assert.equal(job.status,'queued');
    await raw.query(`UPDATE gpu_resource_fences SET safety_state='clear', subject_kind=NULL,
      subject_id=NULL, lease_id=NULL, attempt_id=NULL WHERE worker_id=$1 AND gpu_uuid=$2`,[worker.id,uuid]);
    await scheduler.runOnce();
    const assigned=await persistence.getJob(job.id);
    assert.equal(assigned.status,'leased');
    assert.equal(assigned.assignedGpuUuid,uuid);
  });
});

test('B2C2B2A PostgreSQL: scheduler-style fence read locks held row against independent writer',{...pgGate,timeout:30_000},async()=>{
  await fixture(async ({persistence,raw,worker,uuid})=>{
    await raw.query(`INSERT INTO gpu_resource_fences
      (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at)
      VALUES ($1,$2,1,'cleanup_required','job','fixture','fixture-lease',1)`,[worker.id,uuid]);
    let entered; const readEntered=new Promise(r=>{entered=r});
    let release; const gate=new Promise(r=>{release=r});
    const t=persistence.transaction(async txn=>{
      assert.equal(await txn.tryAcquireSchedulerLock(),true);
      assert.equal((await txn.listBlockedGpuResources()).length,1);
      entered();
      await gate;
    });
    try {
      await readEntered;
      const writer=await raw.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '200ms'");
        await assert.rejects(writer.query(`UPDATE gpu_resource_fences
          SET updated_at=updated_at+1 WHERE worker_id=$1 AND gpu_uuid=$2`,[worker.id,uuid]),/lock timeout|canceling statement/u);
        await writer.query('ROLLBACK');
      } finally {writer.release()}
    } finally {release(); await t}
  });
});
