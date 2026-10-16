import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {requestTestBroker,claimTestBrokerAttempt} from '../src/worker/workload-broker-client.mjs';

const brokerScript = path.resolve('src/broker/broker_server.py');
const artifact = {adapterId:'com.example.echo',version:'1.0.0',sha256:'a'.repeat(64)};
const intent = {schemaVersion:1,attemptId:'attempt-1',sessionId:'session-1',leaseId:'lease-1',
  leaseGeneration:3,runtimeId:'isolated-oci-1',reservationId:'reservation-1',artifact,requiredIpcVersion:1};
let next=0;
const future = () => Date.now()+600000;
function fixture({uid=process.getuid(),generation=3,trustClass='operator-trusted',verified=true,expiresAtMs=future()}={}) {
  return {
    principals:[{uid,workerId:'worker-1',runtimeIds:['isolated-oci-1']}],
    leases:[{sessionId:'session-1',leaseId:'lease-1',generation,workerId:'worker-1',status:'active',expiresAtMs}],
    reservations:[{reservationId:'reservation-1',attemptId:'attempt-1',leaseId:'lease-1',
      status:'held',expiresAtMs:future(),deviceIds:['gpu-opaque-1']}],
    approvals:[{artifact,imageDigest:`sha256:${'b'.repeat(64)}`,runtimeId:'isolated-oci-1',profileId:'locked-profile',
      trustClass,requiredControls:['process','filesystem','network','identity','resource-limits','gpu-device']}],
    runtimes:[{runtimeId:'isolated-oci-1',available:true,
      supportedIpcVersions:[1],verifiedControls:verified ? ['process','filesystem','network','identity','resource-limits','gpu-device'] : []}],
  };
}
function temp() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpulink-b2b-'));
  fs.chmodSync(dir,0o700);
  return {dir,db:path.join(dir,'state.sqlite'),fixture:path.join(dir,'fixture.json'),socket:path.join(dir,'sock'+(++next))};
}
async function launch(paths, f=fixture()) {
  fs.writeFileSync(paths.fixture,JSON.stringify(f),{mode:0o600});
  const child=spawn('python3',[brokerScript,'--test-only','--socket',paths.socket,'--db',paths.db,'--fixture',paths.fixture],
    {stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  let stdout='',stderr='';
  const ready = await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`broker readiness timeout: ${stderr}`)),4000);
    child.stdout.on('data',buf=>{stdout+=buf.toString();if(stdout.includes('B2B_TEST_BROKER_READY')){
      clearTimeout(timeout);resolve(true);
    }});
    child.stderr.on('data',buf=>{stderr+=buf.toString();});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`broker exited (${code}): ${stderr}`));});
  });
  assert.equal(ready,true);
  return {child, async stop(){if (child.exitCode===null) {child.kill('SIGTERM');await once(child,'exit');}}};
}
async function withBroker(run, opts={}) {
  const p=temp(); let server;
  try {server=await launch(p,fixture(opts));await run(p,server);} finally {
    if (server) await server.stop();
    fs.rmSync(p.dir,{recursive:true,force:true});
  }
}
const claim = socketPath => claimTestBrokerAttempt({socketPath,intent});
const inspect = (socketPath,attemptId='attempt-1') => requestTestBroker({socketPath,operation:'inspect',payload:{attemptId}});
const cancel = socketPath => requestTestBroker({socketPath,operation:'cancel',payload:{attemptId:'attempt-1'}});

test('B2B: kernel-authenticated peer claims a durable advisory attempt; never launch permission', async()=>{
  await withBroker(async ({socket}) => {
    const result=await claim(socket);
    assert.deepEqual(result,{schemaVersion:1,status:'reserved-test-only',canLaunch:false,attemptId:'attempt-1',advisoryOnly:true});
    assert.equal((await inspect(socket)).state,'reserved');
    assert.equal((await cancel(socket)).state,'cancelled');
    assert.equal((await inspect(socket)).state,'cancelled');
  });
});
test('B2B: exact attempt cannot be claimed again after cancellation',async()=>{
  await withBroker(async ({socket})=>{
    await claim(socket); await cancel(socket);
    await assert.rejects(claim(socket),{code:'broker_attempt_replay'});
  });
});
test('B2B: concurrent duplicate attempts produce exactly one reserved owner',async()=>{
  await withBroker(async ({socket})=>{
    const results=await Promise.allSettled(Array.from({length:12},()=>claim(socket)));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected' && x.reason.code==='broker_attempt_replay').length,11);
  });
});
test('B2B: peer UID comes from Linux kernel and is NOT user-supplied JSON',async()=>{
  await withBroker(async ({socket})=>{
    await assert.rejects(claim(socket),{code:'broker_unauthorized_peer'});
  },{uid:process.getuid()+1});
});
test('B2B: stale lease generation and expired lease fail closed',async()=>{
  await withBroker(async ({socket})=>assert.rejects(claim(socket),{code:'broker_stale_lease'}),{generation:4});
  await withBroker(async ({socket})=>assert.rejects(claim(socket),{code:'broker_stale_lease'}),{expiresAtMs:Date.now()-1000});
});
test('B2B: no third-party or unverifiable runtime promotion',async()=>{
  await withBroker(async ({socket})=>assert.rejects(claim(socket),{code:'broker_artifact_not_approved'}),{trustClass:'reviewed-third-party'});
  await withBroker(async ({socket})=>assert.rejects(claim(socket),{code:'broker_runtime_not_verified'}),{verified:false});
});
test('B2B: unknown operations and injected executable/device fields fail closed',async()=>{
  await withBroker(async ({socket})=>{
    await assert.rejects(requestTestBroker({socketPath:socket,operation:'launch',payload:{intent}}),{code:'broker_unsupported_operation'});
    await assert.rejects(claimTestBrokerAttempt({socketPath:socket,intent:{...intent,command:'/bin/bash'}}),{code:'broker_invalid_intent'});
    await assert.rejects(claimTestBrokerAttempt({socketPath:socket,intent:{...intent,gpuDevice:'0'}}),{code:'broker_invalid_intent'});
    assert.equal((await inspect(socket).catch(e=>e.code)),'broker_attempt_not_found');
  });
});
test('B2B: broker restart quarantines reserved attempt and forbids resurrected claim',async()=>{
  const p=temp(); let first,second;
  try {
    first=await launch(p);await claim(p.socket);await first.stop();first=null;
    const newSocket=path.join(p.dir,'restart.sock');
    second=await launch({...p,socket:newSocket});
    assert.equal((await inspect(newSocket)).state,'quarantined');
    await assert.rejects(claim(newSocket),{code:'broker_attempt_replay'});
  } finally {if(first)await first.stop();if(second)await second.stop();fs.rmSync(p.dir,{recursive:true,force:true});}
});
test('B2B: cannot run production broker without explicit test-only flag',async()=>{
  const p=temp();
  try {
    fs.writeFileSync(p.fixture,JSON.stringify(fixture()));
    const c=spawn('python3',[brokerScript,'--socket',p.socket,'--db',p.db,'--fixture',p.fixture],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
    const [code]=await once(c,'exit');
    assert.equal(code,2);
    assert.equal(fs.existsSync(p.socket),false);
  } finally {fs.rmSync(p.dir,{recursive:true,force:true});}
});

test('B2B: single writer lock blocks a second broker against the same journal',async()=>{
  const p=temp(); let first;
  try {
    first=await launch(p);
    const conflicting=spawn('python3',[brokerScript,'--test-only','--socket',path.join(p.dir,'other.sock'),
      '--db',p.db,'--fixture',p.fixture],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    let stderr='';conflicting.stderr.on('data',b=>stderr+=b.toString());
    const [code]=await once(conflicting,'exit');
    assert.equal(code,2);assert.match(stderr,/broker_ledger_owned/);
    assert.equal((await claim(p.socket)).canLaunch,false);
  } finally {if(first)await first.stop();fs.rmSync(p.dir,{recursive:true,force:true});}
});

async function rawFrame(socketPath,frame) {
  const net = await import('node:net');
  return new Promise((resolve,reject)=>{
    const sock=net.createConnection({path:socketPath});let accum=Buffer.alloc(0);
    sock.on('connect',()=>sock.end(frame));
    sock.on('data',chunk=>accum=Buffer.concat([accum,chunk]));
    sock.on('error',reject);
    sock.on('close',()=>{
      if(accum.length<4)return reject(new Error('missing response'));
      resolve(JSON.parse(accum.subarray(4).toString()));
    });
  });
}
const packet = str => {const b=Buffer.from(str);const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);};
test('B2B: wire rejects duplicate keys and non-finite JSON',async()=>{
  await withBroker(async ({socket})=>{
    const duplicate=await rawFrame(socket,packet('{"schemaVersion":1,"schemaVersion":1,"operation":"inspect","payload":{"attemptId":"attempt-1"}}'));
    assert.equal(duplicate.ok,false); assert.equal(duplicate.code,'broker_invalid_message');
    const nan=await rawFrame(socket,packet('{"schemaVersion":1,"operation":"inspect","payload":{"attemptId":NaN}}'));
    assert.equal(nan.ok,false);assert.equal(nan.code,'broker_invalid_message');
  });
});
test('B2B: wire rejects oversized frames and credential assertions',async()=>{
  await withBroker(async ({socket})=>{
    const big=Buffer.alloc(4);big.writeUInt32BE(65535);
    const result=await rawFrame(socket,big);
    assert.equal(result.code,'broker_message_too_large');
    const fake=await rawFrame(socket,packet(JSON.stringify({schemaVersion:1,operation:'inspect',payload:{attemptId:'attempt-1'},
      workerId:'worker-1',authenticated:true})));
    assert.equal(fake.code,'broker_invalid_message');
  });
});
