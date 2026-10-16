import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
import {parseBrokerProfiles} from '../src/control-plane/broker-claim-service.mjs';
import {reserveAuthoritativeBrokerAttempt,spawnSyntheticProvenanceProbe,observeSyntheticProvenanceProbe,requestTestBroker} from '../src/worker/workload-broker-client.mjs';
import {createTestContext,registerWorker,submitJob,gpu} from './helpers.mjs';

const SCRIPT=path.resolve('src/broker/broker_server.py');
const TOKEN='d2c-synthetic-operator-token-not-production';
const ATTEMPT='attempt-d2c-synthetic-probe';
const ORIGIN='broker-created-fixed-synthetic-child-test-only';
const sql=(db,script)=>{
  const p=spawnSync('python3',['-B','-c',script,db],{encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);return p.stdout.trim();
};
const expected=(status,observation='unknown',reason='no_provenance_intent',source='none')=>({
  schemaVersion:1,attemptId:ATTEMPT,status,origin:ORIGIN,observation,reason,source,
  workloadLaunchAttested:false,authorityConfirmed:false,cleanupVerified:false,
  canLaunch:false,canRelease:false,advisoryOnly:true
});
async function rig(run,{enabled=true,wrongUid=false,wrongScope=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-d2c-'));fs.chmodSync(dir,0o700);
  const ctx=createTestContext({initialNow:1_700_000_000_000});
  const p={db:path.join(dir,'broker.sqlite'),sock:path.join(dir,'broker.sock'),fixture:path.join(dir,'fixture.json'),
    token:path.join(dir,'token'),config:path.join(dir,'config.json')};
  let cp,child;
  const stop=async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=null;};
  const start=async(sock=p.sock)=>{
    const args=[SCRIPT,'--test-only','--db',p.db,'--socket',sock,'--fixture',p.fixture,'--authority-config',p.config];
    if(enabled)args.push('--synthetic-provenance-probe');
    child=spawn('python3',args,{stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}});
    return Promise.race([new Promise((resolve,reject)=>{
      let text='',stderr='';child.stdout.on('data',b=>{text+=b;if(text.includes('B2B_TEST_BROKER_READY'))resolve(sock);});
      child.stderr.on('data',b=>stderr+=b);
      child.once('exit',code=>reject(new Error(`broker failed ${code} ${stderr}`)));
    }),new Promise((_,reject)=>setTimeout(()=>reject(new Error('broker start timeout')),5000))]);
  };
  try {
    const worker=await registerWorker(ctx,{name:'d2c-probe',gpus:[gpu({uuid:'gpu-d2c-test',memoryTotalMiB:8192})]});
    const profiles=parseBrokerProfiles(JSON.stringify([{brokerId:'d2c-broker',workerId:worker.id,
      projectId:wrongScope?'not-test-project':'test-project',token:TOKEN,
      artifactDigest:'sha256:'+'c'.repeat(64),adapterIdentity:'approved-adapter',
      runtimePolicyRevision:'operator-policy',approvalRef:'approval'}]));
    const service=new ControlPlaneService(ctx.database,ctx.scheduler,{...ctx.config,brokerProfiles:profiles},{clock:ctx.clock});
    cp=createHttpServer({service,database:ctx.database,scheduler:ctx.scheduler});
    await new Promise(resolve=>cp.listen(0,'127.0.0.1',resolve));
    fs.writeFileSync(p.fixture,JSON.stringify({principals:[{uid:process.getuid()+(wrongUid?10000:0),
      workerId:worker.id,runtimeIds:['test-runtime']}],leases:[],reservations:[],approvals:[],runtimes:[]}),{mode:0o600});
    fs.writeFileSync(p.token,TOKEN,{mode:0o600});
    fs.writeFileSync(p.config,JSON.stringify({schemaVersion:1,workerId:worker.id,
      baseUrl:`http://127.0.0.1:${cp.address().port}`,tokenFile:p.token}),{mode:0o600});
    const job=await submitJob(ctx);
    const reserve=(sock=p.sock)=>reserveAuthoritativeBrokerAttempt({socketPath:sock,request:{
      subjectKind:'job',subjectId:job.id,leaseId:job.leaseId,attemptId:ATTEMPT}});
    const invoke=(sock=p.sock)=>spawnSyntheticProvenanceProbe({socketPath:sock,attemptId:ATTEMPT});
    const observe=(sock=p.sock)=>observeSyntheticProvenanceProbe({socketPath:sock,attemptId:ATTEMPT});
    await run({p,ctx,worker,job,start,stop,reserve,invoke,observe});
  } finally {
    await stop();if(cp)await new Promise(resolve=>cp.close(resolve));await ctx.close();fs.rmSync(dir,{recursive:true,force:true});
  }
}
const held=ctx=>ctx.database.transaction(tx=>tx.listBlockedGpuResources());

test('D2C: provenance fixture absent unless separately opted in',()=>rig(async({start,reserve,invoke})=>{
  await start();await reserve();await assert.rejects(invoke(),{code:'broker_authority_disabled'});
},{enabled:false}));

test('D2C: without a durable control-plane reservation, probe never spawns',()=>rig(async({start,invoke,observe})=>{
  await start();await assert.rejects(invoke(),{code:'broker_attempt_unknown'});
  await assert.rejects(observe(),{code:'broker_attempt_unknown'});
}));

test('D2C: broker creates fixed GPU-free process only after durable intent and held fence',()=>rig(async({start,reserve,invoke,observe,p,ctx})=>{
  await start();await reserve();assert.deepEqual(await observe(),expected('no_intent'));
  assert.deepEqual(await invoke(),{schemaVersion:1,attemptId:ATTEMPT,status:'synthetic-probe-recorded',
    origin:ORIGIN,intentDurable:true,identityObserved:true,workloadLaunchAttested:false,
    cleanupVerified:false,canLaunch:false,canRelease:false,advisoryOnly:true});
  assert.deepEqual(await observe(),expected('synthetic_identity_recorded','present','identity_present','linux-procfs-v1'));
  assert.equal(sql(p.db,"import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); print(','.join(str(row[0]) for row in c.execute('SELECT sequence FROM synthetic_probe_events ORDER BY sequence')))"),'1,2');
  await assert.rejects(invoke(),{code:'broker_provenance_exists'});
  assert.equal((await held(ctx)).length,1);
}));

test('D2C: restart keeps a broker-origin synthetic birth record, never converts it into release',()=>rig(async({start,stop,reserve,invoke,observe,p,ctx})=>{
  await start();await reserve();await invoke();await stop();
  const sock=path.join(path.dirname(p.sock),'restart.sock');await start(sock);
  const result=await observe(sock);
  assert.equal(result.status,'synthetic_identity_recorded');
  assert.equal(result.workloadLaunchAttested,false);
  assert.equal(result.canRelease,false);
  await assert.rejects(invoke(sock),{code:'broker_authority_uncertain'});
  assert.equal((await held(ctx)).length,1);
}));

test('D2C: prepared-only crash gap remains uncertain across restart, never retries fork',()=>rig(async({start,stop,reserve,invoke,observe,p,ctx,worker,job})=>{
  await start();await reserve();await stop();
  sql(p.db,`import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1])\nr=c.execute('SELECT attempt_id,lease_id,worker_id,fence_epoch FROM remote_claims').fetchone()\nc.execute('INSERT INTO synthetic_probe_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',(r[0],1,'intent_durable',r[1],r[2],r[3],None,None,None,None,int(time.time()*1000)))\nc.commit()`);
  const sock=path.join(path.dirname(p.sock),'restart.sock');await start(sock);
  assert.deepEqual(await observe(sock),expected('intent_uncertain','unknown','birth_not_committed'));
  await assert.rejects(invoke(sock),{code:'broker_authority_uncertain'});
  assert.equal((await held(ctx)).length,1);
}));

test('D2C: kernel peer mismatch, project scope, and injection all fail closed',async()=>{
  await rig(async({start,reserve,invoke})=>{
    await start();await assert.rejects(reserve(),{code:'broker_unauthorized_peer'});
    await assert.rejects(invoke(),{code:'broker_unauthorized_peer'});
  },{wrongUid:true});
  await rig(async({start,reserve,invoke})=>{
    await start();await assert.rejects(reserve(),{code:'broker_authority_uncertain'});
    await assert.rejects(invoke(),{code:'broker_authority_uncertain'});
  },{wrongScope:true});
  await rig(async({start,reserve,p})=>{
    await start();await reserve();
    for(const operation of ['spawn-synthetic-probe','observe-synthetic-probe'])
      await assert.rejects(requestTestBroker({socketPath:p.sock,operation,
        payload:{attemptId:ATTEMPT,command:'danger',gpu:42,pid:process.pid}}),{code:'broker_invalid_message'});
  });
});

test('D2C: journal events reject SQL modification and deletion',()=>rig(async({start,reserve,invoke,stop,p})=>{
  await start();await reserve();await invoke();await stop();
  const out=sql(p.db,`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nfor q in ('UPDATE synthetic_probe_events SET pid=1','DELETE FROM synthetic_probe_events'):\n try:\n  c.execute(q)\n  raise AssertionError('immutable journal mutated')\n except sqlite3.IntegrityError: pass\nprint('IMMUTABLE')`);
  assert.equal(out,'IMMUTABLE');
}));

test('D2C: inconsistent persisted birth record blocks startup, no repair or release',()=>rig(async({start,reserve,invoke,stop,p,ctx})=>{
  await start();await reserve();await invoke();await stop();
  sql(p.db,`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('DROP TRIGGER synthetic_probe_no_update')\nc.execute("UPDATE synthetic_probe_events SET lease_id='changed' WHERE sequence=2")\nc.commit()`);
  const sock=path.join(path.dirname(p.sock),'corrupt.sock');
  await assert.rejects(start(sock),/broker failed 2/);
  assert.equal(fs.existsSync(sock),false);
  assert.equal((await held(ctx)).length,1);
}));
