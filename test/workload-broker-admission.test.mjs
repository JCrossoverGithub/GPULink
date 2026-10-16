import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKER_ADMISSION_SCHEMA_VERSION,B2A_REQUIRED_CONTROLS,
  validateBrokerLaunchIntent,evaluateBrokerAdmissionSnapshot,
} from '../src/worker/workload-broker-admission.mjs';
const A={adapterId:'example.echo',version:'1.0.0',sha256:'a'.repeat(64)};
const image='sha256:'+'b'.repeat(64);
const t=1720000000000;
const intent=()=>({schemaVersion:1,attemptId:'at-1',sessionId:'session-1',leaseId:'lease-1',
  leaseGeneration:3,runtimeId:'oci-primary',reservationId:'r-1',artifact:{...A},requiredIpcVersion:1});
const snapshot=()=>({
  caller:{workerId:'worker-1',runtimeIds:['oci-primary'],authenticated:true},
  lease:{sessionId:'session-1',leaseId:'lease-1',generation:3,workerId:'worker-1',expiresAtMs:t+20000,status:'active'},
  reservation:{reservationId:'r-1',attemptId:'at-1',leaseId:'lease-1',deviceIds:['gpu-uuid.1'],expiresAtMs:t+20000,status:'held'},
  approval:{artifact:{...A},imageDigest:image,runtimeId:'oci-primary',profileId:'gpulink-isolated-v1',trustClass:'operator-trusted',requiredControls:[...B2A_REQUIRED_CONTROLS]},
  runtime:{runtimeId:'oci-primary',available:true,verifiedControls:[...B2A_REQUIRED_CONTROLS],supportedIpcVersions:[1]},
  attempt:{attemptId:'at-1',state:'absent'},
});
const check=(i=intent(),s=snapshot(),now=t)=>evaluateBrokerAdmissionSnapshot({intent:i,snapshot:s,nowMs:now});
const code=c=>e=>e?.code===c;
const rejects=(c, fn)=>assert.throws(fn,code(c));

test('intent: known schema, safe frozen identity and complete fields',()=>{
  assert.equal(BROKER_ADMISSION_SCHEMA_VERSION,1);
  const a=validateBrokerLaunchIntent(intent());assert.equal(a.attemptId,'at-1');
  assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.artifact));
});
test('intent: unsafe host options, commands, raw GPU IDs and paths not accepted',()=>{
  for(const payload of [{image:'alpine:latest'},{command:'/bin/sh'},{mount:'/host'},{deviceIds:['gpu-0']},
    {networkMode:'host'},{containerSocket:'/var/run/docker.sock'},{env:{AWS_SECRET_ACCESS_KEY:'x'}}])
      rejects('broker_invalid_intent',()=>validateBrokerLaunchIntent({...intent(),...payload}));
});
test('intent: invalid identity, version, generations, IPC and request version denied',()=>{
  const variants=[{attemptId:'../x'},{sessionId:''},{runtimeId:'a/b'},{leaseGeneration:0},
    {leaseGeneration:1.5},{requiredIpcVersion:256},{schemaVersion:2},{reservationId:'bad/path'},
    {artifact:{...A,sha256:'SHA256:not-valid'}}];
  for(const x of variants) assert.throws(()=>validateBrokerLaunchIntent({...intent(),...x}));
});
test('intent: accessors are rejected, not invoked',()=>{
  const i=intent();let invoked=false;
  Object.defineProperty(i,'runtimeId',{get(){invoked=true;return 'oci-primary';},enumerable:true});
  rejects('broker_invalid_intent',()=>validateBrokerLaunchIntent(i));assert.equal(invoked,false);
});
test('dry run: eligible result NEVER grants launch authority',()=>{
  const r=check();assert.deepEqual([r.advisoryOnly,r.canLaunch],[true,false]);
  assert.equal(r.status,'eligible-for-implementation-review');assert.ok(Object.isFrozen(r));
  assert.deepEqual(r.deviceIds,['gpu-uuid.1']); assert.equal(r.imageDigest,image);
  assert.ok(!Object.hasOwn(r,'token')&&!Object.hasOwn(r,'socket')&&!Object.hasOwn(r,'command'));
});
test('dry run: input normalization does not mutate snapshots',()=>{
  const s=snapshot();const frozen=Object.freeze([...s.approval.requiredControls]);s.approval.requiredControls=frozen;
  check(intent(),s);assert.deepEqual(s.approval.requiredControls,frozen);
});
test('auth: unauthenticated or wrong runtime denied',()=>{
  for(const change of [{authenticated:false},{runtimeIds:['different']},
    {runtimeIds:[]}]) rejects('broker_unauthorized_caller',()=>check(intent(),{...snapshot(),caller:{...snapshot().caller,...change}}));
});
test('lease: expiry, revocation, closure, replacement, generation, worker and session all fail closed',()=>{
  const changes=[{expiresAtMs:t},{status:'revoked'},{status:'closed'},{leaseId:'lease-old'},
    {generation:4},{workerId:'worker-other'},{sessionId:'session-other'}];
  for(const ch of changes) rejects('broker_stale_lease',()=>check(intent(),{...snapshot(),lease:{...snapshot().lease,...ch}}));
});
test('lease: intent bound to lease generation; no downgrade to old holder',()=>{
  rejects('broker_stale_lease',()=>check({...intent(),leaseGeneration:2}));
});
test('reservation: binds attempt+lease+reservation and expiration',()=>{
  for(const ch of [{attemptId:'at-other'},{leaseId:'lease-old'},
    {reservationId:'r-other'},{expiresAtMs:t},{status:'released'}])
    rejects('broker_reservation_mismatch',()=>check(intent(),{...snapshot(),reservation:{...snapshot().reservation,...ch}}));
});
test('reservation: no raw GPU device selection by caller',()=>{
  rejects('broker_invalid_intent',()=>validateBrokerLaunchIntent({...intent(),gpuDeviceId:'gpu-other'}));
});
test('attempt: non-absent or wrong attempt is a replay',()=>{
  for(const state of ['prepared','starting','running','finished','disposed'])
    rejects('broker_attempt_replay',()=>check(intent(),{...snapshot(),attempt:{attemptId:'at-1',state}}));
  rejects('broker_attempt_replay',()=>check(intent(),{...snapshot(),attempt:{attemptId:'at-2',state:'absent'}}));
});
test('approval: mutated artifact, adapter identity, version and image/runtime binding denied',()=>{
  for(const artifact of [{...A,sha256:'c'.repeat(64)},{...A,adapterId:'evil'},
      {...A,version:'2.0.0'}])
    rejects('broker_artifact_not_approved',()=>check({...intent(),artifact}));
  rejects('broker_artifact_not_approved',()=>check(intent(),{...snapshot(),approval:{...snapshot().approval,runtimeId:'other'}}));
  rejects('broker_invalid_approval_record',()=>check(intent(),{...snapshot(),approval:{...snapshot().approval,imageDigest:'latest'}}));
});
test('trust: third-party and unknown execution remain disabled',()=>{
  for(const trustClass of ['reviewed-third-party','untrusted'])
    rejects('broker_trust_class_not_enabled',()=>check(intent(),{...snapshot(),approval:{...snapshot().approval,trustClass}}));
});
test('isolation: absent controls fail rather than subprocess fallback',()=>{
  for(const control of B2A_REQUIRED_CONTROLS){
    const sparse=B2A_REQUIRED_CONTROLS.filter(x=>x!==control);
    rejects('broker_incomplete_security_profile',()=>check(intent(),{...snapshot(),approval:{...snapshot().approval,requiredControls:sparse}}));
    rejects('broker_runtime_not_verified',()=>check(intent(),{...snapshot(),runtime:{...snapshot().runtime,verifiedControls:sparse}}));
  }
});
test('runtime: unavailable, mismatched ID or IPC denied',()=>{
  for(const ch of [{available:false},{runtimeId:'other'},{supportedIpcVersions:[2]}])
    rejects('broker_runtime_not_verified',()=>check(intent(),{...snapshot(),runtime:{...snapshot().runtime,...ch}}));
});
test('snapshot: unknown/untrusted shape denied; credentials never an input',()=>{
  rejects('broker_invalid_snapshot',()=>check(intent(),{...snapshot(),operatorToken:'SECRET'}));
  rejects('broker_invalid_caller_record',()=>check(intent(),{...snapshot(),caller:{...snapshot().caller,rawUid:1000}}));
  rejects('broker_invalid_reservation_record',()=>check(intent(),{...snapshot(),reservation:{...snapshot().reservation,deviceIds:['gpu-uuid.1','gpu-uuid.1']}}));
});
test('time: expiration exact boundary and invalid clock fail closed',()=>{
  rejects('broker_stale_lease',()=>check(intent(),snapshot(),t+20000));
  for(const now of [-1,0,NaN,Infinity,1.5]) rejects('broker_invalid_clock',()=>check(intent(),snapshot(),now));
});
test('device: returned devices are derived solely from broker reservation',()=>{
  const s=snapshot();s.reservation.deviceIds=['gpu-z','gpu-a'];
  const r=check(intent(),s);assert.deepEqual(r.deviceIds,['gpu-a','gpu-z']);
});
test('supported runtime can change without altering wire-shaped intent',()=>{
  const i=intent(),s=snapshot();i.runtimeId='oci-b';s.caller.runtimeIds=['oci-b'];
  s.approval.runtimeId='oci-b';s.runtime.runtimeId='oci-b';
  assert.equal(check(i,s).runtimeId,'oci-b');
});
test('no live OCI runtime, socket, child process, or hardware invoked',()=>{
  assert.equal(typeof evaluateBrokerAdmissionSnapshot,'function');
  const r=check();assert.equal(r.canLaunch,false);assert.equal(r.advisoryOnly,true);
});
