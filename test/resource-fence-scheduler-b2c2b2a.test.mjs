import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqlitePersistence } from '../src/control-plane/persistence/sqlite.mjs';
import { ControlPlaneDatabase } from '../src/control-plane/database.mjs';
import { ControlPlaneService } from '../src/control-plane/service.mjs';
import { Scheduler } from '../src/control-plane/scheduler.mjs';
import { gpu, registerWorker, submitJob } from './helpers.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpulink-b2c2b2a-'));
  const file = path.join(dir, 'test.sqlite');
  const database = new SqlitePersistence(file);
  let now = 1_700_000_000_000;
  const clock = () => now;
  const config = {
    tokens: {
      client: 'client-test-token-long-enough-for-valid-auth-xxxxxxxx',
      worker: 'worker-test-token-long-enough-for-valid-auth-xxxxxxxx',
      admin: 'admin-test-token-long-enough-for-valid-auth-xxxxxxxx',
    },
    heartbeatTimeoutMs: 60_000,
    leaseDurationMs: 10_000,
    vramSafetyMiB: 512,
  };
  const scheduler = new Scheduler(database, {...config, clock});
  const service = new ControlPlaneService(database, scheduler, config, { clock });
  const context = {database, scheduler, service, clock, advance: (ms) => (now += ms)};
  const raw = new ControlPlaneDatabase(file);
  try { await fn(context, raw); }
  finally { await database.close(); raw.close(); rmSync(dir, {recursive: true, force:true}); }
}

function putFence(raw, workerId, deviceId, state, { lease='lease_fixture', subject='subject_fixture' } = {}) {
  const held = state !== 'clear';
  raw.database.prepare(`INSERT INTO gpu_resource_fences
    (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at)
    VALUES (?,?,1,?,?,?,?,?)`).run(workerId, deviceId, state,
    held ? 'job' : null, held ? subject : null, held ? lease : null, 1);
}

function clearFence(raw, workerId, deviceId) {
  raw.database.prepare(`UPDATE gpu_resource_fences
    SET safety_state='clear', subject_kind=NULL,subject_id=NULL,lease_id=NULL,
        attempt_id=NULL, updated_at=updated_at+1
    WHERE worker_id=? AND gpu_uuid=?`).run(workerId, deviceId);
}

test('B2C2B2A: query reads only held resource identities and omits clean epochs', async () => {
  await fixture(async (ctx, raw) => {
    const w = await registerWorker(ctx, {name: 'fence-read-worker', gpus: [gpu({uuid:'held',memoryTotalMiB:8192}), gpu({uuid:'clear',memoryTotalMiB:8192})]});
    putFence(raw,w.id,'held','quarantined');
    putFence(raw,w.id,'clear','clear');
    assert.deepEqual(await ctx.database.listBlockedGpuResources(),[{workerId:w.id,gpuUuid:'held'}]);
    assert.deepEqual(await ctx.database.transaction(t => t.listBlockedGpuResources()),[{workerId:w.id,gpuUuid:'held'}]);
  });
});

test('B2C2B2A: quarantined device cannot receive a new queued job', async () => {
  await fixture(async (ctx, raw) => {
    const w = await registerWorker(ctx, {name:'quarantine-worker',gpus:[gpu({uuid:'gpu-quarantine',memoryTotalMiB:8192})]});
    putFence(raw,w.id,'gpu-quarantine','quarantined');
    const job = await submitJob(ctx);
    assert.equal(job.status,'queued');
    assert.equal(job.assignedGpuUuid,null);
  });
});

test('B2C2B2A: a hold on one device leaves another worker eligible', async () => {
  await fixture(async (ctx, raw) => {
    const a = await registerWorker(ctx,{name:'fast-held',gpus:[gpu({uuid:'GPU-IDENTICAL',memoryTotalMiB:24576,utilizationPercent:0})]});
    const b = await registerWorker(ctx,{name:'slow-unheld',gpus:[gpu({uuid:'GPU-IDENTICAL',memoryTotalMiB:24576,utilizationPercent:35})]});
    putFence(raw,a.id,'GPU-IDENTICAL','cleanup_required');
    const job = await submitJob(ctx);
    assert.equal(job.status,'leased');
    assert.equal(job.assignedWorkerId,b.id);
    assert.notEqual(job.assignedWorkerId,a.id);
  });
});

test('B2C2B2A: expired logical lease does not release durable GPU hold', async () => {
  await fixture(async (ctx, raw) => {
    const w = await registerWorker(ctx,{name:'expiry-held',gpus:[gpu({uuid:'lease-expiry-gpu',memoryTotalMiB:8192})]});
    const first = await submitJob(ctx);
    assert.equal(first.status,'leased');
    putFence(raw,w.id,'lease-expiry-gpu','running',{lease:first.leaseId,subject:first.id});
    ctx.advance(10_001);
    await ctx.scheduler.runOnce();
    const recovered = await ctx.database.getJob(first.id);
    assert.equal(recovered.status,'queued');
    assert.equal(recovered.assignedGpuUuid,null);
    assert.deepEqual(await ctx.database.listBlockedGpuResources(),[{workerId:w.id,gpuUuid:'lease-expiry-gpu'}]);
  });
});

test('B2C2B2A: only explicit cleared fence lets the scheduler reuse GPU', async () => {
  await fixture(async (ctx, raw) => {
    const w = await registerWorker(ctx,{name:'cleanup-held',gpus:[gpu({uuid:'cleanup-gpu',memoryTotalMiB:8192})]});
    putFence(raw,w.id,'cleanup-gpu','cleanup_required');
    const first = await submitJob(ctx);
    assert.equal(first.status,'queued');
    clearFence(raw,w.id,'cleanup-gpu'); // test-only fixture; real cleanup API NOT implemented.
    await ctx.scheduler.runOnce();
    const assigned = await ctx.database.getJob(first.id);
    assert.equal(assigned.status,'leased');
    assert.equal(assigned.assignedWorkerId,w.id);
  });
});

test('B2C2B2A: fence read failure fails whole scheduler pass closed', async () => {
  const scheduler = new Scheduler({
    transaction: (callback) => callback({
      tryAcquireSchedulerLock: async () => true,
      markStaleWorkersOffline: async () => [],
      recoverExpiredJobs: async () => [],
      recoverInterruptedSessions: async () => [],
      listBlockedGpuResources: async () => { throw new Error('cannot verify fence state'); },
    }),
  },{heartbeatTimeoutMs: 60_000,leaseDurationMs:1000,vramSafetyMiB:0,clock:()=>2000});
  await assert.rejects(scheduler.runOnce(),/cannot verify fence state/);
});

test('B2C2B2A: committed quarantine is visible across independent SQLite connections', async () => {
  await fixture(async (ctx, raw) => {
    const w = await registerWorker(ctx,{name:'restart-fence',gpus:[gpu({uuid:'gpu-durable',memoryTotalMiB:8192})]});
    putFence(raw,w.id,'gpu-durable','quarantined');
    const persisted = raw.database.prepare('SELECT safety_state FROM gpu_resource_fences WHERE worker_id=? AND gpu_uuid=?').get(w.id,'gpu-durable');
    assert.equal(persisted.safety_state,'quarantined');
    assert.deepEqual(await ctx.database.listBlockedGpuResources(),[{workerId:w.id,gpuUuid:'gpu-durable'}]);
  });
});
