import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {parseBrokerProfiles,observeBrokerBoundAttempt} from '../src/control-plane/broker-claim-service.mjs';
import {requestTestBroker,reserveAuthoritativeBrokerAttempt} from '../src/worker/workload-broker-client.mjs';
import {createTestContext,registerWorker,submitJob,gpu} from './helpers.mjs';

// These broker/host tests require Linux kernel identity and process APIs.
// Never emulate a peer UID on Windows; Linux CI must execute the real tests.
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

const TOKEN='local-readonly-broker-token-not-a-real-credential';
const BASE=path.resolve('src/broker/broker_server.py');
const held = epoch => ({schemaVersion:1,attemptId:'readonly-attempt',disposition:'held',
  fenceEpoch:epoch,canLaunch:false,canRelease:false,evidenceVerified:false});
async function rig(run,{scope='test-project',allowUid=true}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-d1-'));
 fs.chmodSync(dir,0o700);
 const ctx=createTestContext({initialNow:1_700_000_000_000});
 let cp,child;
 const paths={socket:path.join(dir,'broker.sock'),journal:path.join(dir,'broker.sqlite'),
   fixture:path.join(dir,'fixture.json'),token:path.join(dir,'token'),config:path.join(dir,'config')};
 const start=async(socketPath=paths.socket)=>{
   child=spawn('python3',[BASE,'--test-only','--fixture',paths.fixture,'--db',paths.journal,
       '--socket',socketPath,'--authority-config',paths.config],{stdio:['ignore','pipe','pipe'],
       env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}});
   await Promise.race([new Promise((resolve,reject)=>{
     let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('B2B_TEST_BROKER_READY'))resolve();});
     child.once('exit',code=>reject(new Error('broker exited '+code)));
   }),new Promise((_,reject)=>setTimeout(()=>reject(new Error('broker startup timed out')),5000))]);
 };
 const stop=async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}};
 try {
  const worker=await registerWorker(ctx,{name:'read-only-reconciliation',gpus:[
    gpu({uuid:'gpu-d1-readonly',memoryTotalMiB:8192})]});
  const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'d1-broker',workerId:worker.id,
    projectId:scope,token:TOKEN,artifactDigest:'sha256:'+'b'.repeat(64),
    adapterIdentity:'operator-adapter',runtimePolicyRevision:'operator-revision',
    approvalRef:'operator-approval'}]));
  const service=new ControlPlaneService(ctx.database,ctx.scheduler,
    {...ctx.config,brokerProfiles:profiles},{clock:ctx.clock});
  cp=createHttpServer({service,database:ctx.database,scheduler:ctx.scheduler});
  await new Promise(resolve=>cp.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(paths.fixture,JSON.stringify({principals:[{uid:process.getuid()+(allowUid?0:10000),
    workerId:worker.id,runtimeIds:['test-runtime']}],leases:[],reservations:[],approvals:[],runtimes:[]}),{mode:0o600});
  fs.writeFileSync(paths.token,TOKEN,{mode:0o600});
  fs.writeFileSync(paths.config,JSON.stringify({schemaVersion:1,workerId:worker.id,
    baseUrl:`http://127.0.0.1:${cp.address().port}`,tokenFile:paths.token}),{mode:0o600});
  const job=await submitJob(ctx);
  await start();
  const request={subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId:'readonly-attempt'};
  const observe = () => requestTestBroker({socketPath:paths.socket,
    operation:'observe-authoritative',payload:{attemptId:'readonly-attempt'}});
  await run({ctx,job,worker,service,profiles,paths,request,observe,start,stop});
 }finally{
  await stop();
  if(cp) await new Promise(resolve=>cp.close(resolve));
  await ctx.close();fs.rmSync(dir,{recursive:true,force:true});
 }
}
test('D1: missing attempt is not evidence of host cleanup',()=>rig(async({observe,ctx,worker})=>{
 const v=await observe().catch(e=>e);
 assert.equal(v.code,'broker_attempt_unknown');
 assert.deepEqual(await ctx.database.transaction(tx=>tx.listBlockedGpuResources()),[]);
}));

test('D1: exact broker observation confirms database hold but never release',()=>rig(async({paths,request,observe,ctx,worker})=>{
 const claim=await reserveAuthoritativeBrokerAttempt({socketPath:paths.socket,request});
 assert.equal(claim.canLaunch,false);
 const response=await observe();
 assert.deepEqual(response,{...held(1),advisoryOnly:true});
 assert.equal((await ctx.database.transaction(tx=>tx.listBlockedGpuResources())).length,1);
 assert.equal((await observe()).canRelease,false);
}));

test('D1: broker restart can inspect quarantined attempt but cannot release it',()=>rig(async({paths,request,observe,ctx,stop,start})=>{
 await reserveAuthoritativeBrokerAttempt({socketPath:paths.socket,request});
 await stop();
 const next=path.join(path.dirname(paths.socket),'reboot.sock');
 await start(next);
 const snapshot=await requestTestBroker({socketPath:next,
   operation:'observe-authoritative',payload:{attemptId:'readonly-attempt'}});
 assert.equal(snapshot.disposition,'held');
 assert.equal(snapshot.canRelease,false);
 assert.equal((await ctx.database.transaction(tx=>tx.listBlockedGpuResources())).length,1);
}));

test('D1: broker JWT-like or worker tokens cannot see attempt status',()=>rig(async({service,request,ctx})=>{
 const bad=await observeBrokerBoundAttempt({persistence:ctx.database,
   profiles:service.config.brokerProfiles,authorization:'Bearer '+service.config.tokens.worker,
   request:{schemaVersion:1,...request}}).catch(e=>e);
 assert.equal(bad.statusCode,401);
}));

test('D1: unknown identity and injected device arguments rejected before transport',()=>rig(async({paths,request})=>{
 for(const payload of [{attemptId:'not-in-journal'},{attemptId:'readonly-attempt',gpuUuid:'fake'},
   {attemptId:'readonly-attempt',canRelease:true}]){
   await assert.rejects(requestTestBroker({socketPath:paths.socket,
     operation:'observe-authoritative',payload}),e=>['broker_attempt_unknown','broker_invalid_message'].includes(e.code));
 }
}));

test('D1: wrong kernel peer cannot observe with host credential',()=>rig(async({paths})=>{
 await assert.rejects(requestTestBroker({socketPath:paths.socket,
   operation:'observe-authoritative',payload:{attemptId:'readonly-attempt'}}),
   {code:'broker_unauthorized_peer'});
},{allowUid:false}));

test('D1: read-only endpoint never grants release on scope mismatch',()=>rig(async({paths,request,ctx})=>{
 await assert.rejects(reserveAuthoritativeBrokerAttempt({socketPath:paths.socket,request}),
   {code:'broker_authority_uncertain'});
 const result=await requestTestBroker({socketPath:paths.socket,operation:'observe-authoritative',
   payload:{attemptId:'readonly-attempt'}});
 assert.deepEqual(result,{schemaVersion:1,attemptId:'readonly-attempt',disposition:'not_found',
   fenceEpoch:null,canLaunch:false,canRelease:false,evidenceVerified:false,advisoryOnly:true});
},{scope:'other-project'}));
