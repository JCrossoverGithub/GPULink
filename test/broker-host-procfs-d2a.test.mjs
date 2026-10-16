import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {parseBrokerProfiles} from '../src/control-plane/broker-claim-service.mjs';
import {reserveAuthoritativeBrokerAttempt,observeHostBrokerAttempt,requestTestBroker} from '../src/worker/workload-broker-client.mjs';
import {createTestContext,registerWorker,submitJob,gpu} from './helpers.mjs';

const SCRIPT=path.resolve('src/broker/broker_server.py');
const TOKEN='d2a-local-broker-token-not-production-credential';
const ATTEMPT='attempt-d2a-host-procfs';
const readBirth=(pid)=>{
  const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
  const tail=raw.slice(raw.lastIndexOf(')')+1).trim().split(/\s+/);
  return Number(tail[19]);
};
const currentCgroup=pid=>fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').split('\n').find(s=>s.startsWith('0::')).slice(3);
const bootId=()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const expected=(observation,reason,source='none')=>({schemaVersion:1,attemptId:ATTEMPT,
  observation,reason,source,operatorHintOnly:true,authorityConfirmed:false,
  cleanupVerified:false,canLaunch:false,canRelease:false,advisoryOnly:true});

async function rig(run,{witnessMode='none',wrongUid=false,wrongScope=false,invalidPermissions=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-d2a-')); fs.chmodSync(dir,0o700);
  const ctx=createTestContext({initialNow:1_700_000_000_000});
  const p={db:path.join(dir,'broker.sqlite'),sock:path.join(dir,'broker.sock'),fixture:path.join(dir,'fixture.json'),
    token:path.join(dir,'token'),config:path.join(dir,'config.json'),witness:path.join(dir,'runtime-witness.json')};
  let cp,child;
  const stop=async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=null;};
  const start=async(sock=p.sock)=>{
    const args=[SCRIPT,'--test-only','--db',p.db,'--socket',sock,'--fixture',p.fixture,'--authority-config',p.config];
    if(witnessMode!=='none')args.push('--host-witness-file',p.witness);
    child=spawn('python3',args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}});
    return Promise.race([new Promise((resolve,reject)=>{
      let text='',stderr='';child.stdout.on('data',b=>{text+=b;if(text.includes('B2B_TEST_BROKER_READY'))resolve(sock);});
      child.stderr.on('data',b=>stderr+=b);
      child.once('exit',code=>reject(new Error(`broker failed ${code} ${stderr}`)));
    }),new Promise((_,reject)=>setTimeout(()=>reject(new Error('broker start timeout')),5000))]);
  };
  try {
    const worker=await registerWorker(ctx,{name:'d2a-observer',gpus:[gpu({uuid:'gpu-d2a-local',memoryTotalMiB:8192})]});
    const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'d2a-broker',workerId:worker.id,
      projectId:wrongScope?'not-test-project':'test-project',token:TOKEN,
      artifactDigest:'sha256:'+'b'.repeat(64),adapterIdentity:'approved-adapter',
      runtimePolicyRevision:'operator-policy',approvalRef:'approval'}]));
    const service=new ControlPlaneService(ctx.database,ctx.scheduler,{...ctx.config,brokerProfiles:profiles},{clock:ctx.clock});
    cp=createHttpServer({service,database:ctx.database,scheduler:ctx.scheduler});
    await new Promise(resolve=>cp.listen(0,'127.0.0.1',resolve));
    fs.writeFileSync(p.fixture,JSON.stringify({principals:[{uid:process.getuid()+(wrongUid?10000:0),
      workerId:worker.id,runtimeIds:['test-runtime']}],leases:[],reservations:[],approvals:[],runtimes:[]}),{mode:0o600});
    fs.writeFileSync(p.token,TOKEN,{mode:0o600});
    fs.writeFileSync(p.config,JSON.stringify({schemaVersion:1,workerId:worker.id,
      baseUrl:`http://127.0.0.1:${cp.address().port}`,tokenFile:p.token}),{mode:0o600});
    const witness={attemptId:ATTEMPT,workerId:worker.id,leaseId:'unknown-until-job',fenceEpoch:1,
      bootId:bootId(),pid:process.pid,startTicks:readBirth(process.pid),cgroupV2:currentCgroup(process.pid)};
    const job=await submitJob(ctx); witness.leaseId=job.leaseId;
    if(witnessMode==='wrongBirth')witness.startTicks+=1;
    if(witnessMode==='wrongBoot')witness.bootId='00000000-0000-0000-0000-000000000000';
    if(witnessMode==='wrongEpoch')witness.fenceEpoch+=1;
    if(witnessMode==='wrongLease')witness.leaseId='stale-lease';
    if(witnessMode==='badShape')witness.injectedPid=42;
    if(witnessMode!=='none'){
      fs.writeFileSync(p.witness,JSON.stringify({schemaVersion:1,witnesses:[witness]}),{mode:0o600});
      if(invalidPermissions)fs.chmodSync(p.witness,0o644);
    }
    await run({p,ctx,worker,job,start,stop,observe:(sock=p.sock)=>observeHostBrokerAttempt({socketPath:sock,attemptId:ATTEMPT}),
      reserve:(sock=p.sock)=>reserveAuthoritativeBrokerAttempt({socketPath:sock,request:{
        subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId:ATTEMPT}})});
  } finally {
    await stop();if(cp)await new Promise(resolve=>cp.close(resolve));await ctx.close();fs.rmSync(dir,{recursive:true,force:true});
  }
}
const held=ctx=>ctx.database.transaction(tx=>tx.listBlockedGpuResources());

test('D2A: unbound accepted attempt remains unknown and fence held',()=>rig(async({start,reserve,observe,ctx})=>{
  await start();await reserve();assert.deepEqual(await observe(),expected('unknown','no_broker_verified_binding'));
  assert.equal((await held(ctx)).length,1);
}));
test('D2A: exact operator hint can observe the current Linux process birth, NOT authorize cleanup',()=>rig(async({start,reserve,observe,ctx})=>{
  await start();await reserve();assert.deepEqual(await observe(),expected('present','identity_present','linux-procfs-v1'));
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));
test('D2A: process birth mismatch is only identity-absent, not cleanup',()=>rig(async({start,reserve,observe,ctx})=>{
  await start();await reserve();assert.deepEqual(await observe(),expected('absent','identity_not_present','linux-procfs-v1'));
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'wrongBirth'}));
test('D2A: host boot mismatch returns unknown, never absent',()=>rig(async({start,reserve,observe,ctx})=>{
  await start();await reserve();assert.deepEqual(await observe(),expected('unknown','boot_mismatch'));
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'wrongBoot'}));
test('D2A: wrong fence epoch or lease witness returns unknown',async()=>{
  for (const witnessMode of ['wrongEpoch','wrongLease'])await rig(async({start,reserve,observe,ctx})=>{
    await start();await reserve();assert.deepEqual(await observe(),expected('unknown','witness_identity_mismatch'));
    assert.equal((await held(ctx)).length,1);
  },{witnessMode});
});
test('D2A: broker restart retains quarantine and does not promote host observation to release',()=>rig(async({start,stop,reserve,observe,p,ctx})=>{
  await start();await reserve();await stop();const sock=path.join(path.dirname(p.sock),'restart.sock');
  await start(sock);assert.deepEqual(await observe(sock),expected('present','identity_present','linux-procfs-v1'));
  await assert.rejects(reserve(sock),{code:'broker_attempt_replay'});
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));
test('D2A: peer scope and supplied process metadata are rejected',()=>rig(async({start,observe,p})=>{
  await start();await assert.rejects(observe(),{code:'broker_unauthorized_peer'});
  await assert.rejects(requestTestBroker({socketPath:p.sock,operation:'observe-host',payload:{attemptId:ATTEMPT,pid:process.pid}}),
    {code:'broker_invalid_message'});
},{wrongUid:true,witnessMode:'correct'}));
test('D2A: unsafe operator witness is rejected before socket listens',()=>rig(async({start,p})=>{
  await assert.rejects(start(),/broker failed 2/);
  assert.equal(fs.existsSync(p.sock),false);
},{witnessMode:'correct',invalidPermissions:true}));
test('D2A: malformed witness schema rejected without runtime inspection',()=>rig(async({start,p})=>{
  await assert.rejects(start(),/broker failed 2/);
  assert.equal(fs.existsSync(p.sock),false);
},{witnessMode:'badShape'}));
