import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresPersistence} from '../src/control-plane/persistence/postgres.mjs';
import {Scheduler} from '../src/control-plane/scheduler.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {gpu,registerWorker,submitJob} from './helpers.mjs';
const url=process.env.GPULINK_TEST_POSTGRES_URL;
const ack=process.env.GPULINK_JOB_CLEANUP_TEST_DB_ACK==='YES_DISPOSABLE';

test('PostgreSQL: running cancellation/expiry and release serialize with placement, remain durable and prevent replay',
  {skip:url&&ack?false:'requires disposable PostgreSQL and GPULINK_JOB_CLEANUP_TEST_DB_ACK=YES_DISPOSABLE',timeout:30000},async()=>{
  const db=new PostgresPersistence(url);const raw=new pg.Pool({connectionString:url,max:2});
  const tag=randomUUID();const projectId=`job-cleanup-${tag}`;const uuid=`GPU-${tag}`;
  let now=1700000000000;const clock=()=>now;const config={heartbeatTimeoutMs:1000,leaseDurationMs:10000,vramSafetyMiB:512};
  const scheduler=new Scheduler(db,{...config,clock});const service=new ControlPlaneService(db,scheduler,config,{clock});const ctx={database:db,scheduler,service};
  const ids=[];const jobs=[];
  const addWorker=async(name,device=uuid)=>{const w=await registerWorker(ctx,{name:`${tag}-${name}`,gpus:[gpu({uuid:device,memoryTotalMiB:8192})]});ids.push(w.id);return w;};
  const addJob=async()=>{const j=await submitJob(ctx,{projectId});jobs.push(j.id);return j;};
  try {
    await db.initialize();
    const w=await addWorker('original');const j=await addJob();assert.equal(j.assignedWorkerId,w.id);
    await service.startJob(j.id,{workerId:w.id,leaseId:j.leaseId});
    // Rollback must preserve job and not leave a hold.
    await assert.rejects(db.transaction(async t=>{await t.cancelJob(j.id,now);throw Error('rollback');}),/rollback/);
    assert.equal((await db.getJob(j.id)).status,'running');
    assert.equal((await db.listJobCleanupHolds()).filter(h=>h.jobId===j.id).length,0);
    // Hold the actual scheduler lock in an independent connection. Cancellation
    // must not commit a terminal job until the allocation lock is released.
    const lock=await raw.connect();let cancellation;
    try {
      await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)',[0x4750554c,0x494e4b31]);
      cancellation=db.cancelJob(j.id,now);
      await new Promise(r=>setTimeout(r,100));
      assert.equal((await db.getJob(j.id)).status,'running');
    } finally {await lock.query('ROLLBACK');lock.release();if(cancellation)await cancellation;}
    const [hold]=(await db.listJobCleanupHolds()).filter(h=>h.jobId===j.id);
    assert.deepEqual(hold,{workerId:w.id,gpuUuid:uuid,epoch:1,jobId:j.id,leaseId:j.leaseId});
    await addWorker('duplicate');const queued=await addJob();assert.equal(queued.status,'queued');
    await assert.rejects(service.releaseJobCleanupHold({...hold,confirmStopped:true}),/mismatch/);
    await service.setWorkerDrain(w.id,{drain:true});now+=1001;await scheduler.runOnce();
    await assert.rejects(service.releaseJobCleanupHold({...hold,epoch:99,confirmStopped:true}),/mismatch/);
    await service.releaseJobCleanupHold({...hold,confirmStopped:true});
    assert.equal((await db.listJobCleanupHolds()).filter(h=>h.jobId===j.id).length,0);
    const rejoined=await addWorker('original');assert.equal(rejoined.id,w.id);
    await service.setWorkerDrain(w.id,{drain:false});await scheduler.runOnce();
    const leased=await db.getJob(queued.id);assert.equal(leased.status,'leased');
    await service.startJob(leased.id,{workerId:leased.assignedWorkerId,leaseId:leased.leaseId});
    await addWorker('other','GPU-'+tag+'-other');
    now+=10001;await scheduler.runOnce();
    const lost=await db.getJob(leased.id);assert.equal(lost.status,'failed');assert.equal(lost.attempt,1);
    assert.equal(lost.error.code,'execution_cleanup_required');
    assert.ok((await db.listJobCleanupHolds()).some(h=>h.jobId===leased.id));
  } finally {
    // Only the disposable test's own rows are removed.
    try {
      await raw.query('DELETE FROM execution_attempts WHERE worker_id=ANY($1::text[])',[ids]);
      await raw.query('DELETE FROM gpu_resource_fences WHERE worker_id=ANY($1::text[])',[ids]);
      await raw.query('DELETE FROM events WHERE subject_id=ANY($1::text[])',[ids.concat(jobs)]);
      await raw.query('DELETE FROM jobs WHERE project_id=$1',[projectId]);
      await raw.query('DELETE FROM workers WHERE id=ANY($1::text[])',[ids]);
    } finally {await raw.end();await db.close();}
  }
});
