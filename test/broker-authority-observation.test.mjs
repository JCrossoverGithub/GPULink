import assert from 'node:assert/strict';
import test from 'node:test';
import { SqlitePersistence } from '../src/control-plane/persistence/sqlite.mjs';
import { observeAuthoritativeSessionLease as observe } from '../src/control-plane/broker-authority-observation.mjs';

const NOW = 1700000000000;
const expected = Object.freeze({sessionId:'session-a',leaseId:'lease-a',workerId:'worker-a',gpuUuid:'GPU-A'});
const makeSession = id => ({
  id, schemaVersion:1, projectId:'test', capability:'example.echo', priority:1,
  requirements:{gpuCount:1,minVramMiB:0,capabilities:[],model:null,adapter:null},
  metadata:{},recovery:{maxInterruptions:1},idempotencyKey:id,now:NOW,
});
const worker = (overrides={}) => ({
  id:'worker-a',name:'worker-a',version:'1.0.0',baseUrl:null,labels:{},capabilities:[],
  adapterManifests:[],adapterHealth:[],warmModels:[],modelInventory:[],
  gpus:[{uuid:'GPU-A'}],now:NOW,...overrides,
});
const check = (db, options={}) => observe({persistence:db,expected,nowMs:NOW+1000,...options});
const rejectCode = async (operation, code) => assert.rejects(operation, error => error?.code===code);

async function withDb(fn) {
  const db = new SqlitePersistence(':memory:');
  try {
    await db.upsertWorker(worker());
    await db.insertSession(makeSession('session-a'));
    const allocated=await db.assignSession('session-a', {workerId:'worker-a',gpuUuid:'GPU-A'}, 'lease-a',NOW+20000,NOW);
    assert.equal(allocated.status,'allocated');
    return await fn(db);
  } finally { await db.close(); }
}

test('observes persisted current lease but ALWAYS rejects launch authority', ()=>withDb(async db=>{
  const o=await check(db);
  assert.equal(o.status,'observed-current-not-fenced');
  assert.equal(o.canLaunch,false);
  assert.equal(o.observationOnly,true);
  assert.equal(o.generationVerified,false);
  assert.equal(o.attemptReservationVerified,false);
  assert.equal(o.leaseExpiresAtMs,NOW+20000);
  assert.equal(Object.isFrozen(o),true);
}));
test('reads allocated, connecting and active states through real persistence',()=>withDb(async db=>{
  assert.equal((await check(db)).sessionStatus,'allocated');
  await db.startSession('session-a','worker-a','lease-a',NOW+20000,NOW+500);
  assert.equal((await check(db)).sessionStatus,'connecting');
  await db.activateSession('session-a','worker-a','lease-a',NOW+20000,NOW+600);
  assert.equal((await check(db)).sessionStatus,'active');
}));
test('rejects a substituted current lease',()=>withDb(db=>rejectCode(
  ()=>observe({persistence:db,expected:{...expected,leaseId:'lease-stale'},nowMs:NOW+1000}),
  'broker_authoritative_lease_not_current')));
test('rejects an incorrect assigned worker',()=>withDb(db=>rejectCode(
  ()=>observe({persistence:db,expected:{...expected,workerId:'worker-other'},nowMs:NOW+1000}),
  'broker_authoritative_lease_not_current')));
test('rejects incorrect assigned GPU',()=>withDb(db=>rejectCode(
  ()=>observe({persistence:db,expected:{...expected,gpuUuid:'GPU-B'},nowMs:NOW+1000}),
  'broker_authoritative_lease_not_current')));
test('rejects the exact lease expiry boundary',()=>withDb(db=>rejectCode(
  ()=>observe({persistence:db,expected,nowMs:NOW+20000,maxWorkerAgeMs:30000}),
  'broker_authoritative_lease_not_current')));
test('rejects a closed or revoked live session',()=>withDb(async db=>{
  await db.closeSession('session-a',NOW+500);
  await rejectCode(()=>check(db),'broker_authoritative_lease_not_current');
}));
test('rejects offline worker after authoritative state change',()=>withDb(async db=>{
  await db.markStaleWorkersOffline(NOW+1,NOW+2);
  await rejectCode(()=>check(db),'broker_authoritative_worker_unavailable');
}));
test('rejects drained worker',()=>withDb(async db=>{
  await db.setWorkerDrain('worker-a',true,NOW+1);
  await rejectCode(()=>check(db),'broker_authoritative_worker_unavailable');
}));
test('rejects stale worker heartbeat without trusting caller assertions',()=>withDb(db=>rejectCode(
  ()=>observe({persistence:db,expected,nowMs:NOW+6000,maxWorkerAgeMs:1000}),
  'broker_authoritative_worker_unavailable')));
test('rejects missing GPU in authoritative worker inventory',()=>withDb(async db=>{
  await db.updateWorkerHeartbeat('worker-a',{
    capabilities:[],adapterManifests:[],adapterHealth:[],warmModels:[],modelInventory:[],
    gpus:[{uuid:'GPU-B'}],now:NOW+500,
  });
  await rejectCode(()=>check(db),'broker_authoritative_gpu_missing');
}));
test('rejects duplicate GPU occupancy by a second persisted session',()=>withDb(async db=>{
  await db.insertSession(makeSession('session-b'));
  await db.assignSession('session-b',{workerId:'worker-a',gpuUuid:'GPU-A'},'lease-b',NOW+20000,NOW);
  await rejectCode(()=>check(db),'broker_authoritative_gpu_conflict');
}));
test('rejects a simultaneously leased job on the same persisted GPU',()=>withDb(async db=>{
  await db.insertJob({id:'job-a',projectId:'test',type:'diagnostic.echo',priority:1,
    minVramMiB:0,requiredCapabilities:[],requestedModel:null,payload:{},maxAttempts:1,
    idempotencyKey:'job-a',now:NOW});
  await db.assignJob('job-a',{workerId:'worker-a',gpuUuid:'GPU-A'},'job-lease',NOW+20000,NOW);
  await rejectCode(()=>check(db),'broker_authoritative_gpu_conflict');
}));
test('rejects malformed query including direct device and generation injection',()=>withDb(async db=>{
  await rejectCode(()=>observe({persistence:db,expected:{...expected,deviceIds:['/dev/nvidia0']},nowMs:NOW+1000}),
    'broker_invalid_authority_query');
  await rejectCode(()=>observe({persistence:db,expected:{...expected,leaseGeneration:1},nowMs:NOW+1000}),
    'broker_invalid_authority_query');
}));
test('rejects accessor properties before reading them',()=>withDb(async db=>{
  const evil={...expected};
  Object.defineProperty(evil,'workerId',{get(){throw new Error('executed getter');},enumerable:true});
  await rejectCode(()=>observe({persistence:db,expected:evil,nowMs:NOW+1000}),
    'broker_invalid_authority_query');
}));
test('missing or broken authority providers fail closed and never launch',async ()=>{
  await rejectCode(()=>observe({persistence:{},expected,nowMs:NOW+1000}),'broker_authority_unavailable');
  await rejectCode(()=>observe({persistence:{transaction:async()=>{throw Error('secret');}},expected,nowMs:NOW+1000}),
    'broker_authority_unavailable');
});
test('read transaction does NOT grant authority surviving later revocation',()=>withDb(async db=>{
  const first=await check(db);
  assert.equal(first.canLaunch,false);
  await db.closeSession('session-a',NOW+1001);
  await rejectCode(()=>check(db),'broker_authoritative_lease_not_current');
  assert.equal(first.canLaunch,false);
}));
