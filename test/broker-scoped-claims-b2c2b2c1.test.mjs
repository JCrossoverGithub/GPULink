import assert from 'node:assert/strict';
import test from 'node:test';
import { loadControlPlaneConfig } from '../src/control-plane/config.mjs';
import { parseBrokerProfiles } from '../src/control-plane/broker-claim-service.mjs';
import { createHttpServer } from '../src/control-plane/http-server.mjs';
import { ControlPlaneService } from '../src/control-plane/service.mjs';
import { createTestContext, gpu, registerWorker, submitJob } from './helpers.mjs';

const NOW = 1_700_000_000_000;
const TOKEN = 'broker-token-unique-and-extremely-long-ABCDEF';
const BASE = {
  GPULINK_CLIENT_TOKEN: 'client-config-token-a-super-secret-example',
  GPULINK_WORKER_TOKEN: 'worker-config-token-a-super-secret-example',
  GPULINK_ADMIN_TOKEN: 'admin-config-token-a-super-secret-example',
  GPULINK_DATA_PLANE_SIGNING_KEY: 'signing-key-a-super-secret-example-abcdef',
};
const profile = (workerId, overrides={}) => ({
  brokerId: 'broker_A', workerId, projectId: 'test-project', token:TOKEN,
  artifactDigest: 'sha256:'+'f'.repeat(64), adapterIdentity:'adapter_pinned',
  runtimePolicyRevision:'operator_rev_1', approvalRef:'approval_operator_A', ...overrides,
});
const request = (subject, changes={}) => ({
  schemaVersion: 1, subjectKind:'job', subjectId:subject.id,
  leaseId:subject.leaseId, attemptId:'attempt_A', ...changes,
});

async function fixture(run, configured = true) {
  const ctx=createTestContext({initialNow:NOW});
  let http=null;
  try {
    const worker=await registerWorker(ctx,{name:'broker-worker',gpus:[gpu({uuid:'gpu-authoritative-A',memoryTotalMiB:8192})]});
    const claimConfig = {...ctx.config, brokerProfiles: configured ? parseBrokerProfiles(JSON.stringify([profile(worker.id)]),Object.values(ctx.config.tokens)) : []};
    const service = new ControlPlaneService(ctx.database,ctx.scheduler,claimConfig,{clock:ctx.clock});
    http=createHttpServer({service,database:ctx.database,scheduler:ctx.scheduler});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${http.address().port}`;
    const send=async (auth,body) => {
      const headers = {'Content-Type':'application/json'};
      if (auth) headers.Authorization=`Bearer ${auth}`;
      const response=await fetch(base+'/v1/broker/attempts/reserve',{
        method:'POST',headers,body:JSON.stringify(body),
      });
      return {status:response.status,body:await response.json()};
    };
    await run({ctx, worker,service,send});
  } finally {
    if (http) await new Promise(resolve=>http.close(resolve));
    await ctx.close();
  }
}

test('B2C2B2C1: operator profiles default disabled; strict identities and disjoint token scopes',()=>{
 assert.deepEqual(loadControlPlaneConfig(BASE).brokerProfiles,[]);
 const config=loadControlPlaneConfig({...BASE, GPULINK_BROKER_PROFILES_JSON: JSON.stringify([profile('worker_A')])});
 assert.equal(config.brokerProfiles[0].workerId,'worker_A');
 assert.ok(Object.isFrozen(config.brokerProfiles[0]));
 assert.throws(()=>parseBrokerProfiles('not-json'),/invalid/);
 assert.throws(()=>parseBrokerProfiles(JSON.stringify([profile('worker_A',{token:BASE.GPULINK_WORKER_TOKEN})]),Object.values(BASE)),/ambiguous|reused/);
 assert.throws(()=>parseBrokerProfiles(JSON.stringify([profile('worker_A'),profile('worker_B',{brokerId:'broker_A',token:'unique-other-broker-token-with-enough-length'})])),/ambiguous|reused/);
 assert.throws(()=>parseBrokerProfiles(JSON.stringify([{...profile('worker_A'),command:'/bin/sh'}])),/invalid/);
 assert.throws(()=>parseBrokerProfiles(JSON.stringify([profile('worker_A',{artifactDigest:'sha256:fake'})])),/digest/);
 assert.throws(()=>parseBrokerProfiles(JSON.stringify([profile('worker_A',{token:'short'})])),/credential/);
});

test('B2C2B2C1: endpoint is absent unless operator configured a broker principal',()=>fixture(async({ctx,send})=>{
 const job=await submitJob(ctx);
 const result=await send(TOKEN,request(job));
 assert.equal(result.status,404);
},false));

test('B2C2B2C1: worker/admin/client tokens cannot claim a broker attempt',()=>fixture(async({ctx,send})=>{
 const job=await submitJob(ctx);
 for (const token of [null,ctx.config.tokens.worker,ctx.config.tokens.client,ctx.config.tokens.admin,'wrong-broker-token']) {
  const result=await send(token,request(job));
  assert.equal(result.status,401);
 }
 const got=await ctx.database.transaction(tx=>tx.listBlockedGpuResources());
 assert.deepEqual(got,[]);
}));

test('B2C2B2C1: authenticated claim derives worker, GPU, clock and approval exclusively from authority',()=>fixture(async({ctx,worker,send})=>{
 const job=await submitJob(ctx);
 assert.equal(job.assignedWorkerId,worker.id);
 const result=await send(TOKEN,request(job));
 assert.equal(result.status,201);
 assert.deepEqual(result.body.result,{schemaVersion:1,attemptId:'attempt_A',fenceEpoch:1,status:'reserved-not-launchable',canLaunch:false});
 const held=await ctx.database.transaction(tx=>tx.listBlockedGpuResources());
 assert.deepEqual(held,[{workerId:worker.id,gpuUuid:job.assignedGpuUuid}]);
 // No request-supplied approval, worker, GPU or clock accepted.
 for (const injected of [{workerId:worker.id},{gpuUuid:job.assignedGpuUuid},{now:NOW},{artifactDigest:'sha256:'+'f'.repeat(64)},{approvalRef:'fake'},{canLaunch:true}]) {
  const rejected=await send(TOKEN,request(job,{attemptId:'attempt_extra',...injected}));
  assert.equal(rejected.status,400);
 }
 const duplicate=await send(TOKEN,request(job));
 assert.equal(duplicate.status,409);
 const replaced=await send(TOKEN,request(job,{leaseId:'lease_wrong',attemptId:'attempt_different'}));
 assert.equal(replaced.status,409);
}));

test('B2C2B2C1: broker bound to worker and project cannot claim other project or changed lease',()=>fixture(async({ctx,send})=>{
 const job=await submitJob(ctx,{projectId:'other-project'});
 assert.equal(job.status,'leased');
 assert.equal((await send(TOKEN,request(job))).status,409);
 assert.deepEqual(await ctx.database.transaction(tx=>tx.listBlockedGpuResources()),[]);
}));

test('B2C2B2C1: concurrent HTTP reserve requests have a single winner and no launch authority',()=>fixture(async({ctx,send})=>{
 const job=await submitJob(ctx);
 const [a,b]=await Promise.all([send(TOKEN,request(job,{attemptId:'attempt_one'})),send(TOKEN,request(job,{attemptId:'attempt_two'}))]);
 assert.deepEqual([a.status,b.status].sort(),[201,409]);
 assert.equal((a.status===201?a:b).body.result.canLaunch,false);
 assert.equal((await ctx.database.transaction(tx=>tx.listBlockedGpuResources())).length,1);
}));

test('B2C2B2C1: static broker identity cannot reserve another registered worker GPU',()=>fixture(async({ctx,worker,send})=>{
 const other=await registerWorker(ctx,{name:'other-gpu-operator',gpus:[gpu({uuid:'gpu-authoritative-B',memoryTotalMiB:24000})]});
 const job=await submitJob(ctx,{constraints:{minVramMiB:16000}});
 assert.equal(job.status,'leased');assert.equal(job.assignedWorkerId,other.id);
 assert.notEqual(other.id,worker.id);
 assert.equal((await send(TOKEN,request(job))).status,409);
 assert.deepEqual(await ctx.database.transaction(tx=>tx.listBlockedGpuResources()),[]);
}));

test('B2C2B2C1: a current session may be claimed, but never launched',()=>fixture(async({ctx,worker,send})=>{
 const result=await ctx.service.submitSession({
  projectId:'test-project',capability:'diagnostic.echo',
  requirements:{minVramMiB:1000,capabilities:['diagnostic.echo']},
 });
 const session=result.session;
 assert.equal(session.status,'allocated');assert.equal(session.assignedWorkerId,worker.id);
 const response=await send(TOKEN,request(session,{subjectKind:'session'}));
 assert.equal(response.status,201);
 assert.equal(response.body.result.canLaunch,false);
 const replay=await send(TOKEN,request(session,{subjectKind:'session',attemptId:'next_attempt'}));
 assert.equal(replay.status,409);
}));
