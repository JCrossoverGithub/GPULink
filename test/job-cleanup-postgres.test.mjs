import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {signalFrame} from '../src/shared/change-signals.mjs';
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
    const snapshot=await db.readOperationalState(clock,config.heartbeatTimeoutMs);
    assert.equal(snapshot.atomic,true);assert.equal(snapshot.devices.find(d=>d.workerId===w.id&&d.gpuUuid===uuid).state,'job-cleanup-hold');
    assert.ok(snapshot.events.some(e=>e.subjectId===j.id));assert.ok(!JSON.stringify(snapshot).includes(j.leaseId));
    // The manager must not join the scheduler's fence row locks. Read the
    // committed hold while an independent connection owns the row lock.
    const fenceWriter=await raw.connect();
    try {
      await fenceWriter.query('BEGIN');
      await fenceWriter.query('UPDATE gpu_resource_fences SET updated_at=updated_at+1 WHERE worker_id=$1 AND gpu_uuid=$2',[w.id,uuid]);
      const concurrent=await db.readOperationalState(clock,config.heartbeatTimeoutMs);
      assert.equal(concurrent.devices.find(d=>d.workerId===w.id&&d.gpuUuid===uuid).state,'job-cleanup-hold');
    } finally {await fenceWriter.query('ROLLBACK');fenceWriter.release();}

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

test('PostgreSQL: external batch placement and bounded persisted result use existing job API',
  {skip:url&&ack?false:'requires disposable PostgreSQL and GPULINK_JOB_CLEANUP_TEST_DB_ACK=YES_DISPOSABLE',timeout:30000},async()=>{
  const db=new PostgresPersistence(url); const raw=new pg.Pool({connectionString:url,max:2});
  const tag=randomUUID(), projectId=`batch-${tag}`, type=`external.batch.${tag}`;
  const uuid=`GPU-${tag}`, clock=()=>1700000000000;
  const config={heartbeatTimeoutMs:1000,leaseDurationMs:10000,vramSafetyMiB:512};
  const scheduler=new Scheduler(db,{...config,clock});const service=new ControlPlaneService(db,scheduler,config,{clock});
  const ids=[], jobs=[];
  try {
    await db.initialize();
    const base={version:'test',labels:{},capabilities:[type],warmModels:[],gpus:[gpu({uuid,memoryTotalMiB:8192})]};
    const legacy=await service.registerWorker({...base,name:`${tag}-legacy`}); ids.push(legacy.id);
    const {job}=await service.submitJob({projectId,type,payload:{x:1}});jobs.push(job.id);assert.equal(job.status,'queued');
    const manifest={schemaVersion:2,type,adapterId:`batch.${tag}`,version:'1.0.0',executionMode:'bounded-process'};
    const w=await service.registerWorker({...base,name:`${tag}-batch`,adapterManifests:[manifest],adapterHealth:[{schemaVersion:2,type,adapterId:manifest.adapterId,state:'ready',code:'ready',checkedAt:clock()}]});ids.push(w.id);
    await scheduler.runOnce(); const leased=await db.getJob(job.id); assert.equal(leased.assignedWorkerId,w.id);
    const lease={workerId:w.id,leaseId:leased.leaseId}; await service.startJob(job.id,lease);
    await assert.rejects(service.finishJob(job.id,{...lease,outcome:'succeeded',result:{x:'x'.repeat(32768)}}),/exceeds/);
    await service.finishJob(job.id,{...lease,outcome:'succeeded',result:{x:2}});
    assert.deepEqual((await db.getJob(job.id)).result,{x:2});
    assert.equal((await db.getJob(job.id)).leaseExpiresAt,null);
  } finally {
    try {await raw.query('DELETE FROM events WHERE subject_id=ANY($1::text[])',[ids.concat(jobs)]);await raw.query('DELETE FROM jobs WHERE project_id=$1',[projectId]);await raw.query('DELETE FROM workers WHERE id=ANY($1::text[])',[ids]);}
    finally {await raw.end();await db.close();}
  }
});

// Uses the existing explicitly disposable CI database. A different persistence
// instance commits the event: the HTTP stream must see the LISTEN/NOTIFY signal.
test('PostgreSQL: committed cross-instance changes wake the payload-free manager channel',
  {skip:url&&ack?false:'requires disposable PostgreSQL and GPULINK_JOB_CLEANUP_TEST_DB_ACK=YES_DISPOSABLE',timeout:30000},async()=>{
  const db=new PostgresPersistence(url),writer=new PostgresPersistence(url),raw=new pg.Pool({connectionString:url,max:1});
  const tag=randomUUID(),config={tokens:{admin:'manager-admin-token-for-disposable-test-only',client:'manager-client-token-for-disposable-test-only',worker:'manager-worker-token-for-disposable-test-only'},heartbeatTimeoutMs:60000,leaseDurationMs:10000,vramSafetyMiB:512};
  const scheduler=new Scheduler(db,config),service=new ControlPlaneService(db,scheduler,config);
  const server=createHttpServer({database:db,scheduler,service});const abort=new AbortController();let reader;
  try{
    await db.initialize();await writer.initialize();await server.startEventNotifications();server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer '+config.tokens.admin};
    const response=await fetch(origin+'/v1/admin/operational-changes',{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});assert.equal(response.status,200);reader=response.body.getReader();
    const decoder=new TextDecoder();let buffer='';
    async function next(){while(!buffer.includes('\n\n')){const {done,value}=await reader.read();assert.equal(done,false);buffer+=decoder.decode(value,{stream:true});}const n=buffer.indexOf('\n\n')+2,frame=buffer.slice(0,n);buffer=buffer.slice(n);return frame;}
    assert.equal(await next(),signalFrame('ready'));
    await writer.appendEvent('qa.manager_cross_instance',tag,{private:'not streamed'},Date.now());
    let frame;do{frame=await next();}while(frame===signalFrame('heartbeat'));assert.equal(frame,signalFrame('changed'));
    const snap=await (await fetch(origin+'/v1/admin/operational-snapshot',{headers})).json();assert.ok(snap.events.some(e=>e.subjectId===tag));assert.ok(!JSON.stringify(snap).includes('not streamed'));
  }finally{
    abort.abort();await reader?.cancel().catch(()=>{});server.closeEventStreams();if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await server.stopEventNotifications();
    try{await raw.query('DELETE FROM events WHERE subject_id=$1',[tag]);}finally{await raw.end();await writer.close();await db.close();}
  }
});
