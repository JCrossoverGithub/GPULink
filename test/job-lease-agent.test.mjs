import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkerAgent} from '../src/worker/agent.mjs';
import {gpu} from './helpers.mjs';
const w='worker-lease-test'; const job={id:'job-lease-test',type:'diagnostic.echo',status:'leased',leaseId:'lease-test',assignedWorkerId:w,assignedGpuUuid:'GPU-LEASE-TEST',leaseExpiresAt:Date.now()+5000,payload:{}};
const ack=()=>({job:{...job,status:'running',updatedAt:Date.now(),leaseExpiresAt:Date.now()+1000}});
for(const mode of ['renew-rejected','lease-replaced','renew-stalled']){
  test(`worker cooperatively aborts on ${mode} without reporting success or release`,{timeout:5000},async()=>{
    let started=false;let finishes=0;let renewals=0;let starts=0;
    let abortResolve;const aborted=new Promise(r=>{abortResolve=r;});
    const client={
      registerWorker:async()=>({worker:{id:w}}),heartbeat:async()=>{},
      leases:async()=>({jobs:[started?{...job,status:'running',leaseId:mode==='lease-replaced'?'replacement':job.leaseId}:job],sessions:[]}),
      startJob:async()=>{started=true;starts++;return ack();},
      renewJob:async()=>{renewals++;if(mode==='renew-rejected')throw Error('renew denied');if(mode==='renew-stalled')return new Promise(()=>{});return ack();},
      finishJob:async()=>{finishes++;},
    };
    const agent=new WorkerAgent({name:'lease-agent',version:'test',heartbeatIntervalMs:25,assignmentIntervalMs:10,capabilities:['diagnostic.echo'],labels:{},warmModels:[]},{
      client,discoverGpus:async()=>[gpu({uuid:'GPU-LEASE-TEST',memoryTotalMiB:8192})],discoverModelInventory:async()=>[],
      executeJob:async(_job,{signal})=>new Promise(resolve=>{
        const stop=()=>{abortResolve();resolve({shouldNotBeReported:true});};
        if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
      }),
    });
    try {
      await agent.start();await aborted;
      await new Promise(r=>setTimeout(r,40));
      assert.equal(finishes,0);assert.equal(starts,1);
      if(mode!=='lease-replaced')assert.ok(renewals>0);
    } finally{await agent.stop();}
  });
}
