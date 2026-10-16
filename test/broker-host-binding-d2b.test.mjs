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
import {reserveAuthoritativeBrokerAttempt,observeHostBrokerAttempt,captureHostBrokerBinding,observeBoundHostBrokerAttempt,requestTestBroker} from '../src/worker/workload-broker-client.mjs';
import {createTestContext,registerWorker,submitJob,gpu} from './helpers.mjs';

const SCRIPT=path.resolve('src/broker/broker_server.py');
const TOKEN='d2b-local-broker-token-not-production-credential';
const ATTEMPT='attempt-d2b-host-binding';
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

const expectedBound=(observation,reason,brokerMeasured,source='none')=>({schemaVersion:1,attemptId:ATTEMPT,
  observation,reason,source,brokerMeasured,launchAttested:false,authorityConfirmed:false,
  cleanupVerified:false,canLaunch:false,canRelease:false,advisoryOnly:true});

async function rig(run,{witnessMode='none',wrongUid=false,wrongScope=false,invalidPermissions=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-d2b-')); fs.chmodSync(dir,0o700);
  const ctx=createTestContext({initialNow:1_700_000_000_000});
  const p={db:path.join(dir,'broker.sqlite'),sock:path.join(dir,'broker.sock'),fixture:path.join(dir,'fixture.json'),
    token:path.join(dir,'token'),config:path.join(dir,'config.json'),witness:path.join(dir,'runtime-witness.json')};
  let cp,child;
  const stop=async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=null;};
  const start=async(sock=p.sock,{withoutWitness=false}={})=>{
    const args=[SCRIPT,'--test-only','--db',p.db,'--socket',sock,'--fixture',p.fixture,'--authority-config',p.config];
    if(witnessMode!=='none' && !withoutWitness)args.push('--host-witness-file',p.witness);
    child=spawn('python3',args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}});
    return Promise.race([new Promise((resolve,reject)=>{
      let text='',stderr='';child.stdout.on('data',b=>{text+=b;if(text.includes('B2B_TEST_BROKER_READY'))resolve(sock);});
      child.stderr.on('data',b=>stderr+=b);
      child.once('exit',code=>reject(new Error(`broker failed ${code} ${stderr}`)));
    }),new Promise((_,reject)=>setTimeout(()=>reject(new Error('broker start timeout')),5000))]);
  };
  try {
    const worker=await registerWorker(ctx,{name:'d2b-observer',gpus:[gpu({uuid:'gpu-d2b-local',memoryTotalMiB:8192})]});
    const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'d2b-broker',workerId:worker.id,
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
      capture:(sock=p.sock)=>captureHostBrokerBinding({socketPath:sock,attemptId:ATTEMPT}),
      bound:(sock=p.sock)=>observeBoundHostBrokerAttempt({socketPath:sock,attemptId:ATTEMPT}),
      reserve:(sock=p.sock)=>reserveAuthoritativeBrokerAttempt({socketPath:sock,request:{
        subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId:ATTEMPT}})});
  } finally {
    await stop();if(cp)await new Promise(resolve=>cp.close(resolve));await ctx.close();fs.rmSync(dir,{recursive:true,force:true});
  }
}
const held=ctx=>ctx.database.transaction(tx=>tx.listBlockedGpuResources());


test('D2B: no prior capture remains unknown, immutable hold stays',()=>rig(async({start,reserve,bound,ctx})=>{
  await start();await reserve();assert.deepEqual(await bound(),expectedBound('unknown','no_durable_binding',false));
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));

test('D2B: broker measures operator hint against procfs, captures once, retains fence',()=>rig(async({start,reserve,capture,bound,ctx,p})=>{
  await start();await reserve();const result=await capture();
  assert.deepEqual(result,{schemaVersion:1,attemptId:ATTEMPT,status:'captured-test-only',
    brokerMeasured:true,launchAttested:false,cleanupVerified:false,canLaunch:false,
    canRelease:false,advisoryOnly:true});
  assert.deepEqual(await bound(),expectedBound('present','identity_present',true,'linux-procfs-v1'));
  await assert.rejects(capture(),{code:'broker_binding_exists'});
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));

test('D2B: committed captured identity survives broker restart without operator hint file',()=>rig(async({start,stop,reserve,capture,bound,p,ctx})=>{
  await start();await reserve();await capture();await stop();
  const restart=path.join(path.dirname(p.sock),'restart.sock');
  await start(restart,{withoutWitness:true});
  assert.deepEqual(await bound(restart),expectedBound('present','identity_present',true,'linux-procfs-v1'));
  await assert.rejects(capture(restart),{code:'broker_binding_witness_missing'});
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));

test('D2B: wrong birth/boot/fence/lease cannot create binding',async()=>{
  for(const w of ['wrongBirth','wrongBoot','wrongEpoch','wrongLease'])await rig(async({start,reserve,capture,bound,ctx})=>{
    await start();await reserve();await assert.rejects(capture());
    assert.deepEqual(await bound(),expectedBound('unknown','no_durable_binding',false));
    assert.equal((await held(ctx)).length,1);
  },{witnessMode:w});
});

test('D2B: missing witness cannot create binding',()=>rig(async({start,reserve,capture,bound})=>{
  await start();await reserve();await assert.rejects(capture(),{code:'broker_binding_witness_missing'});
  assert.deepEqual(await bound(),expectedBound('unknown','no_durable_binding',false));
}));

test('D2B: no reserve or unauthorized uid never capture binding',async()=>{
  await rig(async({start,capture})=>{await start();await assert.rejects(capture(),{code:'broker_attempt_unknown'});},{witnessMode:'correct'});
  await rig(async({start,capture,reserve})=>{await start();await assert.rejects(capture(),{code:'broker_unauthorized_peer'});await assert.rejects(reserve(),{code:'broker_unauthorized_peer'});},{witnessMode:'correct',wrongUid:true});
});

test('D2B: no client identity, PID, GPU or epoch substitution allowed',()=>rig(async({start,reserve,p,capture})=>{
  await start();await reserve();
  for(const operation of ['capture-host-binding','observe-bound-host']){
    await assert.rejects(requestTestBroker({socketPath:p.sock,operation,
      payload:{attemptId:ATTEMPT,pid:process.pid}}),{code:'broker_invalid_message'});
  }
  await capture();
},{witnessMode:'correct'}));

test('D2B: trusted CP scope mismatch blocks capture, without weakening fence',()=>rig(async({start,reserve,capture,bound,ctx})=>{
  await start();await assert.rejects(reserve(),{code:'broker_authority_uncertain'});
  await assert.rejects(capture(),{code:'broker_authority_uncertain'});
  assert.deepEqual(await bound(),expectedBound('unknown','no_durable_binding',false));
  assert.equal((await held(ctx)).length,0);
},{witnessMode:'correct',wrongScope:true}));

test('D2B: durable binding is SQL immutable (UPDATE and DELETE rejected)',()=>rig(async({start,reserve,capture,p,stop})=>{
  await start();await reserve();await capture();await stop();
  const script=`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nfor q in ("UPDATE host_identity_bindings SET pid=2", "DELETE FROM host_identity_bindings"):\n try:\n  c.execute(q)\n  raise AssertionError('journal mutated')\n except sqlite3.IntegrityError: pass\nprint('IMMUTABLE')`;
  const child=spawn('python3',['-c',script,p.db]);let out='';child.stdout.on('data',d=>out+=d);
  const [code]=await once(child,'exit');assert.equal(code,0);assert.match(out,/IMMUTABLE/);
},{witnessMode:'correct'}));

test('D2B: journal corruption blocks broker startup without silently clearing a hold',()=>rig(async({start,stop,reserve,capture,p,ctx})=>{
  await start();await reserve();await capture();await stop();
  // Bypass application schema with an external privileged SQLite client to
  // emulate storage corruption. The broker must NOT repair or accept it.
  const script=`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('DROP TRIGGER host_binding_no_update')\nc.execute('UPDATE host_identity_bindings SET lease_id=\\'corrupt-lease\\'')\nc.commit()`;
  const child=spawn('python3',['-c',script,p.db]);const [code]=await once(child,'exit');assert.equal(code,0);
  const restart=path.join(path.dirname(p.sock),'corrupt.sock');
  await assert.rejects(start(restart),/broker failed 2/);
  assert.equal(fs.existsSync(restart),false);
  assert.equal((await held(ctx)).length,1);
},{witnessMode:'correct'}));
