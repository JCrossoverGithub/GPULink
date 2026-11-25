import assert from 'node:assert/strict';
import test from 'node:test';
import {createJobLeaseGuard,jobLeaseRemainingMs} from '../src/worker/job-lease-guard.mjs';
const expected={jobId:'job',workerId:'worker',leaseId:'lease'};
const ack={job:{id:'job',assignedWorkerId:'worker',leaseId:'lease',status:'running',updatedAt:1_700_000_000_000,leaseExpiresAt:1_700_000_001_000}};
function fixture(){
  let now=0;let timer;
  const controller=new AbortController();
  const guard=createJobLeaseGuard(controller,expected,{clock:()=>now,schedule:(fn,ms)=>{timer={fn,at:now+ms};return timer;},cancel:t=>{if(timer===t)timer=undefined;}});
  return {guard,controller,advance(ms,fire=true){now+=ms;if(fire&&timer?.at<=now){const t=timer;timer=undefined;t.fn();}},now:()=>now};
}
test('server relative lease deadline subtracts RTT and rejects mismatched acknowledgments',()=>{
  assert.equal(jobLeaseRemainingMs(ack,expected,50),950);
  assert.equal(jobLeaseRemainingMs(ack,{...expected,leaseId:'stale'},0),0);
  assert.equal(jobLeaseRemainingMs(ack,expected,1001),0);
  assert.equal(jobLeaseRemainingMs({},expected,0),0);
});
test('local deadline aborts an unresolved renewal, even with no network response',()=>{
  const f=fixture(); f.advance(50); assert.equal(f.guard.arm(ack,0),950);
  f.advance(949);assert.equal(f.controller.signal.aborted,false);
  f.advance(1);assert.equal(f.controller.signal.aborted,true);
  assert.equal(f.guard.arm(ack,950),0);
});
test('renewal extends authority but a delayed event loop cannot revive a lost deadline',()=>{
  const f=fixture();assert.equal(f.guard.arm(ack,0),1000);
  f.advance(300);assert.equal(f.guard.arm(ack,250),950);
  f.advance(951,false);assert.equal(f.guard.arm(ack,1100),0);
  assert.equal(f.controller.signal.aborted,true);
});
test('completion closes timer; external cancellation never revives',()=>{
  const f=fixture();f.guard.arm(ack,0);f.guard.close();f.advance(5000);
  assert.equal(f.controller.signal.aborted,false);assert.equal(f.guard.check(),false);
  const g=fixture();g.guard.arm(ack,0);g.controller.abort();assert.equal(g.guard.arm(ack,0),0);
});
