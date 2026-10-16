import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {parseBrokerProfiles} from '../src/control-plane/broker-claim-service.mjs';
import {reserveAuthoritativeBrokerAttempt,requestTestBroker} from '../src/worker/workload-broker-client.mjs';
import {createTestContext,registerWorker,submitJob,gpu} from './helpers.mjs';

// These broker/host tests require Linux kernel identity and process APIs.
// Never emulate a peer UID on Windows; Linux CI must execute the real tests.
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

const brokerScript = path.resolve('src/broker/broker_server.py');
const token = 'broker-control-plane-nonproduction-secret-unique';
const waitReady = (child) => new Promise((resolve,reject)=>{
  let stdout='',stderr='';
  const timer=setTimeout(()=>reject(new Error('broker readiness timeout '+stderr)),5000);
  child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.includes('B2B_TEST_BROKER_READY')){clearTimeout(timer);resolve();}});
  child.stderr.on('data',b=>stderr+=b.toString());
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('broker exited '+code+': '+stderr));});
});
const claimRequest = (job,attemptId='attempt-binding-A') => ({subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId});

async function rig(run, {noAuthority=false,principalUid=process.getuid(), projectId='test-project',serverFailure=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-broker-bind-'));
  fs.chmodSync(dir,0o700);
  const ctx=createTestContext({initialNow:1_700_000_000_000});
  const state=path.join(dir,'state.sqlite');
  const sock=path.join(dir,'broker.sock');
  const fixturePath=path.join(dir,'fixture.json');
  const tokenFile=path.join(dir,'broker-token');
  const configFile=path.join(dir,'operator-config.json');
  let cp=null, broker=null;
  const stop=async()=>{if(broker && broker.exitCode===null){broker.kill('SIGTERM');await once(broker,'exit');}broker=null;};
  const start=async (socketPath=sock)=>{
    const argv=[brokerScript,'--test-only','--fixture',fixturePath,'--db',state,'--socket',socketPath];
    if(!noAuthority)argv.push('--authority-config',configFile);
    const child=spawn('python3',argv,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    broker=child;
    await waitReady(child);
    return socketPath;
  };
  try {
    const worker=await registerWorker(ctx,{name:'b2c2b2c2-worker',gpus:[gpu({uuid:'gpu-authority-local',memoryTotalMiB:8192})]});
    const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'broker-B2C2C2',workerId:worker.id,projectId,
      token,artifactDigest:'sha256:'+'a'.repeat(64),adapterIdentity:'adapter-operator',
      runtimePolicyRevision:'revision-one',approvalRef:'approval-one'}]),Object.values(ctx.config.tokens));
    const service=new ControlPlaneService(ctx.database,ctx.scheduler,{...ctx.config,brokerProfiles:profiles},{clock:ctx.clock});
    if(!serverFailure){
      cp=createHttpServer({service,database:ctx.database,scheduler:ctx.scheduler});
      await new Promise(resolve=>cp.listen(0,'127.0.0.1',resolve));
    }
    const baseUrl=`http://127.0.0.1:${cp?.address()?.port ?? 65432}`;
    fs.writeFileSync(fixturePath,JSON.stringify({principals:[{uid:principalUid,workerId:worker.id,runtimeIds:['test-runtime']}],
       leases:[],reservations:[],approvals:[],runtimes:[]}),{mode:0o600});
    fs.writeFileSync(tokenFile,token,{mode:0o600});
    fs.writeFileSync(configFile,JSON.stringify({schemaVersion:1,workerId:worker.id,baseUrl,tokenFile}),{mode:0o600});
    await start();
    const job=await submitJob(ctx);
    assert.equal(job.status,'leased');
    await run({dir,ctx,cp,broker,worker,job,state,sock,start,stop,tokenFile,configFile,fixturePath});
  } finally {
    await stop();
    if(cp)await new Promise(resolve=>cp.close(resolve));
    await ctx.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
const reserve=(socketPath,job,attemptId) => reserveAuthoritativeBrokerAttempt({socketPath,request:claimRequest(job,attemptId)});
const blocked=ctx=>ctx.database.transaction(tx=>tx.listBlockedGpuResources());

test('B2C2B2C2: kernel peer -> host broker -> CP atomic fence; never launch',()=>rig(async({ctx,job,sock,worker,state})=>{
  const result=await reserve(sock,job);
  assert.deepEqual(result,{schemaVersion:1,attemptId:'attempt-binding-A',fenceEpoch:1,
    status:'reserved-not-launchable',canLaunch:false,advisoryOnly:true});
  assert.deepEqual(await blocked(ctx),[{workerId:worker.id,gpuUuid:job.assignedGpuUuid}]);
  assert.equal(fs.existsSync(state),true);
  await assert.rejects(reserve(sock,job),{code:'broker_attempt_replay'});
  assert.deepEqual(await blocked(ctx),[{workerId:worker.id,gpuUuid:job.assignedGpuUuid}]);
}));

test('B2C2B2C2: no bridge configuration means no remote operation',()=>rig(async({ctx,job,sock})=>{
  await assert.rejects(reserve(sock,job),{code:'broker_authority_disabled'});
  assert.deepEqual(await blocked(ctx),[]);
},{noAuthority:true}));

test('B2C2B2C2: caller cannot inject worker, GPU, approval or execution controls',()=>rig(async({ctx,job,sock})=>{
  for(const injected of [{workerId:'fake'},{gpuUuid:'0'},{artifactDigest:'sha256:xx'},{canLaunch:true},{token:'leak'}, {command:'/bin/sh'}]){
    await assert.rejects(reserveAuthoritativeBrokerAttempt({socketPath:sock,request:{...claimRequest(job),...injected}}),{code:'broker_invalid_message'});
  }
  await assert.rejects(requestTestBroker({socketPath:sock,operation:'launch',payload:{}}),{code:'broker_unsupported_operation'});
  assert.deepEqual(await blocked(ctx),[]);
}));

test('B2C2B2C2: OS peer identity, not JSON, gates remote credential use',()=>rig(async({ctx,job,sock})=>{
  await assert.rejects(reserve(sock,job),{code:'broker_unauthorized_peer'});
  assert.deepEqual(await blocked(ctx),[]);
},{principalUid:process.getuid()+123}));

test('B2C2B2C2: operator project scope fails remotely and leaves attempt uncertain',()=>rig(async({ctx,job,sock})=>{
  await assert.rejects(reserve(sock,job),{code:'broker_authority_uncertain'});
  await assert.rejects(reserve(sock,job),{code:'broker_attempt_replay'});
  assert.deepEqual(await blocked(ctx),[]);
},{projectId:'other-project'}));

test('B2C2B2C2: unreachable control plane retains uncertain journal without retry',()=>rig(async({job,sock})=>{
  await assert.rejects(reserve(sock,job),{code:'broker_authority_uncertain'});
  await assert.rejects(reserve(sock,job),{code:'broker_attempt_replay'});
},{serverFailure:true}));

test('B2C2B2C2: restart quarantines acknowledged claim; remote fence stays held',()=>rig(async({ctx,job,sock,dir,stop,start})=>{
  assert.equal((await reserve(sock,job)).canLaunch,false);
  await stop();
  const reboot=path.join(dir,'reboot.sock');
  await start(reboot);
  await assert.rejects(reserve(reboot,job),{code:'broker_attempt_replay'});
  assert.equal((await blocked(ctx)).length,1);
}));

test('B2C2B2C2: independent duplicate broker requests have one winner and no launch',()=>rig(async({ctx,job,sock})=>{
  const results=await Promise.allSettled(Array.from({length:5},(_,i)=>reserve(sock,job,`attempt-${i}`)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await blocked(ctx)).length,1);
  assert.equal(results.find(r=>r.status==='fulfilled').value.canLaunch,false);
}));

test('B2C2B2C2: private credential file rejects group-readable mode on restart',()=>rig(async({job,sock,tokenFile,stop,start,dir})=>{
  await stop();
  fs.chmodSync(tokenFile,0o644);
  const newSock=path.join(dir,'unsafe.sock');
  // Startup rejection is expected and must leave no socket or remote claim.
  const argv=[brokerScript,'--test-only','--fixture',path.join(dir,'fixture.json'),
    '--db',path.join(dir,'state.sqlite'),'--socket',newSock,'--authority-config',path.join(dir,'operator-config.json')];
  const child=spawn('python3',argv,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  const [code]=await once(child,'exit');
  assert.equal(code,2);
  assert.equal(fs.existsSync(newSock),false);
}));

test('B2C2B2C2: external worker IPC cannot supply an accessor or arbitrary fields',()=>rig(async({job,sock})=>{
  let accessed=false;
  const bad={...claimRequest(job)};
  Object.defineProperty(bad,'attemptId',{enumerable:true,get(){accessed=true;return 'evil';}});
  await assert.rejects(reserveAuthoritativeBrokerAttempt({socketPath:sock,request:bad}),{code:'broker_invalid_message'});
  assert.equal(accessed,false);
}));
