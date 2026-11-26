import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createManager} from '../manager/gateway.mjs';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {createTestContext,gpu,registerWorker,submitJob} from './helpers.mjs';
import {executeOperation,parseOperation} from '../manager/operations.mjs';
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`;};
const close=async s=>{s.closeEventStreams?.();s.closeAllConnections();await new Promise(r=>s.close(r));};
const snapshotHeaders={'X-GPULink-Manager':'snapshot-v1'};
const snapshot=async url=>(await fetch(url+'/api/snapshot',{headers:snapshotHeaders})).json();
const operation=(url,token,body,extra={})=>fetch(url+'/api/operation',{method:'POST',headers:{Origin:url,'Sec-Fetch-Site':'same-origin','X-GPULink-Control':token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
const check=async(response,status,outcome)=>{assert.equal(response.status,status);assert.deepEqual(await response.json(),{outcome});};
test('real Core operations: opt-in, exact target, drain preserves work, cancellation holds, session closure',async()=>{
  const ctx=createTestContext({initialNow:Date.now()});const core=createHttpServer(ctx);let manager,readonly;
  try{
    const origin=await listen(core),config={origin,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client};
    const worker=await registerWorker(ctx,{name:'operator-qa',gpus:[gpu({uuid:'GPU-1',memoryTotalMiB:8192}),gpu({uuid:'GPU-2',index:1,memoryTotalMiB:8192})]});
    const job=await submitJob(ctx,{payload:{echo:'private-marker'}});await ctx.service.startJob(job.id,{workerId:worker.id,leaseId:job.leaseId});
    const session=(await ctx.service.submitSession({projectId:'session-qa',capability:'diagnostic.echo',requirements:{minVramMiB:1}})).session;
    readonly=createManager(config);const ro=await listen(readonly);assert.equal((await snapshot(ro)).controlToken,undefined);assert.equal((await operation(ro,'x',{action:'drain',id:worker.id,expected:false})).status,405);
    manager=createManager({...config,controls:true});const url=await listen(manager),initial=await snapshot(url),token=initial.controlToken;assert.match(token,/^[a-f0-9]{64}$/);for(const secret of Object.values(ctx.config.tokens))assert.ok(!JSON.stringify(initial).includes(secret));
    const drain={action:'drain',id:worker.id,expected:false};
    for(const extra of [{Origin:'https://evil.example'},{Origin:''},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':''},{'X-GPULink-Control':'wrong'}])assert.equal((await operation(url,token,drain,extra)).status,403);
    await check(await operation(url,token,{...drain,path:'/v1/scheduler/run'}),400,'invalid-request');
    await check(await operation(url,token,{...drain,id:'../jobs'}),400,'invalid-request');
    await check(await operation(url,token,{...drain,action:'release-hold'}),400,'invalid-request');
    await check(await operation(url,token,{...drain,id:'a'.repeat(3000)}),400,'invalid-request');
    assert.equal((await ctx.database.getWorker(worker.id)).drainMode,false);
    await check(await operation(url,token,drain),200,'acknowledged');assert.equal((await snapshot(url)).workers[0].drainMode,true);assert.equal((await ctx.database.getJob(job.id)).status,'running');assert.equal((await ctx.database.getSession(session.id)).status,'allocated');
    await check(await operation(url,token,drain),409,'state-changed');
    await check(await operation(url,token,{action:'resume',id:worker.id,expected:true}),200,'acknowledged');assert.equal((await snapshot(url)).workers[0].drainMode,false);
    await check(await operation(url,token,{action:'cancel-job',id:job.id,expected:'running'}),200,'acknowledged');const cancelled=await snapshot(url);assert.equal(cancelled.jobs.find(j=>j.id===job.id).status,'cancelled');assert.equal(cancelled.holds[0].jobId,job.id);assert.ok(!JSON.stringify(cancelled).includes('private-marker'));
    await check(await operation(url,token,{action:'close-session',id:session.id,expected:'allocated'}),200,'acknowledged');assert.equal((await snapshot(url)).sessions.find(s=>s.id===session.id).status,'closed');assert.equal((await ctx.database.listJobCleanupHolds()).length,1);
    await check(await operation(url,token,{action:'cancel-job',id:job.id,expected:'running'}),409,'state-changed');
    await close(core);await check(await operation(url,token,{action:'drain',id:worker.id,expected:false}),503,'not-dispatched');
  }finally{if(manager?.listening)await close(manager);if(readonly?.listening)await close(readonly);if(core.listening)await close(core);await ctx.close();}
});
test('mutation acknowledgement failures are uncertain, never retried or redirected',async()=>{
  const ctx=createTestContext({initialNow:Date.now()});const core=createHttpServer(ctx);let proxy,other;
  try{
    const origin=await listen(core),worker=await registerWorker(ctx,{name:'qa',gpus:[gpu({uuid:'GPU-X',memoryTotalMiB:8192})]});
    const snap=await (await fetch(origin+'/v1/admin/operational-snapshot',{headers:{Authorization:'Bearer '+ctx.config.tokens.admin}})).text();
    let posts=0,redirectHits=0,mode='wrong';other=http.createServer((q,r)=>{redirectHits++;r.end();});const dest=await listen(other);
    proxy=http.createServer((q,r)=>{if(q.method==='GET'){r.writeHead(200,{'Content-Type':'application/json'});return r.end(snap);}posts++;q.resume();assert.equal(q.url,`/v1/workers/${worker.id}/drain`);assert.equal(q.headers.authorization,'Bearer admin');if(mode==='redirect'){r.writeHead(307,{Location:dest});r.end();}else if(mode==='drop'){q.socket.destroy();}else if(mode==='rejected'){r.writeHead(409);r.end('private');}else{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({worker:{id:'wrong',drainMode:true},private:'hidden'}));}});
    const url=await listen(proxy),config={origin:url,adminToken:'admin',clientToken:'client'},op=parseOperation({action:'drain',id:worker.id,expected:false});
    for(mode of ['wrong','redirect','drop'])assert.deepEqual(await executeOperation(config,op),{status:502,outcome:'uncertain'});
    mode='rejected';assert.deepEqual(await executeOperation(config,op),{status:409,outcome:'rejected'});assert.equal(posts,4);assert.equal(redirectHits,0);
    for(const bad of [null,[],{action:'constructor',id:'x',expected:false},{action:'drain',id:'.',expected:false},{action:'drain',id:'x',expected:true},{action:'cancel-job',id:'x',expected:'succeeded'}])assert.equal(parseOperation(bad),null);
  }finally{if(proxy?.listening)await close(proxy);if(other?.listening)await close(other);await close(core);await ctx.close();}
});
test('gateway serializes mutations across tabs and invalidates the cached snapshot after dispatch',{timeout:10000},async()=>{
  const ctx=createTestContext({initialNow:Date.now()});const core=createHttpServer(ctx);let proxy,manager,release;
  try{
    const origin=await listen(core),worker=await registerWorker(ctx,{name:'qa',gpus:[gpu({uuid:'GPU-Z',memoryTotalMiB:8192})]});
    let posts=0,enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});
    const gate=new Promise(r=>{release=r;});
    proxy=http.createServer(async(q,r)=>{
      try{
        let body;
        if(q.method==='POST'){posts++;const chunks=[];for await(const chunk of q)chunks.push(chunk);body=Buffer.concat(chunks);enteredResolve();await gate;}
        const result=await fetch(origin+q.url,{method:q.method,headers:{Authorization:q.headers.authorization,...(body?{'Content-Type':'application/json'}:{})},body});
        r.writeHead(result.status,{'Content-Type':'application/json'});r.end(await result.text());
      }catch{r.writeHead(502);r.end();}
    });
    const upstream=await listen(proxy);manager=createManager({origin:upstream,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client,controls:true},{monotonicNow:()=>0});
    const url=await listen(manager),initial=await snapshot(url),op={action:'drain',id:worker.id,expected:false};
    const first=operation(url,initial.controlToken,op);await entered;
    await check(await operation(url,initial.controlToken,op),409,'busy');assert.equal(posts,1);
    release();await check(await first,200,'acknowledged');assert.equal((await snapshot(url)).workers[0].drainMode,true);assert.equal(posts,1);
  }finally{release?.();if(manager?.listening)await close(manager);if(proxy?.listening)await close(proxy);await close(core);await ctx.close();}
});

test('guarded recovery requires exact hold, explicit attestation, offline drained worker and Core confirmation',async()=>{
  const ctx=createTestContext({heartbeatTimeoutMs:1000});const core=createHttpServer(ctx);let manager,readonly;
  try{
    const origin=await listen(core),config={origin,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client};
    const worker=await registerWorker(ctx,{name:'recover-qa',gpus:[gpu({uuid:'GPU-HOLD',memoryTotalMiB:8192})]});
    const job=await submitJob(ctx);await ctx.service.startJob(job.id,{workerId:worker.id,leaseId:job.leaseId});await ctx.service.cancelJob(job.id);
    const [hold]=await ctx.database.listJobCleanupHolds();const {leaseId,...identity}=hold;
    const op={action:'recover-job-hold',...identity,confirmStopped:true,typedGpuUuid:hold.gpuUuid};
    readonly=createManager(config);const ro=await listen(readonly);assert.equal((await operation(ro,'x',op)).status,405);
    manager=createManager({...config,controls:true});const url=await listen(manager),initial=await snapshot(url),token=initial.controlToken;
    assert.ok(!JSON.stringify(initial).includes(leaseId));
    for(const bad of [{...op,confirmStopped:false},{...op,typedGpuUuid:'GPU-WRONG'},{...op,leaseId},{...op,epoch:0}])await check(await operation(url,token,bad),400,'invalid-request');
    await check(await operation(url,token,op,{'X-GPULink-Control':'wrong'}),403,'forbidden');
    await check(await operation(url,token,op),409,'state-changed');
    await ctx.service.setWorkerDrain(worker.id,{drain:true});await check(await operation(url,token,op),409,'state-changed');
    await ctx.service.setWorkerDrain(worker.id,{drain:false});ctx.advance(1001);await ctx.scheduler.runOnce();await check(await operation(url,token,op),409,'state-changed');
    await ctx.service.setWorkerDrain(worker.id,{drain:true});
    await check(await operation(url,token,{...op,epoch:op.epoch+1}),409,'state-changed');
    assert.deepEqual(await ctx.database.listJobCleanupHolds(),[hold]);
    await check(await operation(url,token,op),200,'acknowledged');assert.deepEqual(await ctx.database.listJobCleanupHolds(),[]);
    const released=await snapshot(url);assert.equal(released.holds.length,0);assert.ok(released.events.some(e=>e.type==='job.cleanup_operator_confirmed'&&e.subjectId===job.id));assert.ok(!JSON.stringify(released).includes(leaseId));
    await check(await operation(url,token,op),409,'state-changed');
    assert.equal((await ctx.database.getWorker(worker.id)).drainMode,true);
  }finally{if(manager?.listening)await close(manager);if(readonly?.listening)await close(readonly);await close(core);await ctx.close();}
});

test('recovery resolves private lease, refuses changed identity, never retries uncertain release',async()=>{
  const ctx=createTestContext({heartbeatTimeoutMs:1000});const core=createHttpServer(ctx);let proxy;
  try{
    const origin=await listen(core),w=await registerWorker(ctx,{name:'recover-proxy',gpus:[gpu({uuid:'GPU-PRIVATE',memoryTotalMiB:8192})]});
    const j=await submitJob(ctx);await ctx.service.startJob(j.id,{workerId:w.id,leaseId:j.leaseId});await ctx.service.cancelJob(j.id);await ctx.service.setWorkerDrain(w.id,{drain:true});ctx.advance(1001);await ctx.scheduler.runOnce();
    const [hold]=await ctx.database.listJobCleanupHolds(),{leaseId,...identity}=hold;
    const snap=await (await fetch(origin+'/v1/admin/operational-snapshot',{headers:{Authorization:'Bearer '+ctx.config.tokens.admin}})).text();
    let mode='changed',posts=0;proxy=http.createServer(async(q,r)=>{
      if(q.headers.authorization!=='Bearer admin'){r.writeHead(403);return r.end();}
      if(q.method==='GET'){r.writeHead(200,{'Content-Type':'application/json'});return r.end(q.url.endsWith('operational-snapshot')?snap:JSON.stringify({holds:[{...hold,epoch:mode==='changed'?hold.epoch+1:hold.epoch}]}));}
      posts++;const chunks=[];for await(const c of q)chunks.push(c);assert.equal(q.url,'/v1/admin/job-cleanup-holds/release');assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{...hold,confirmStopped:true});
      if(mode==='drop')return q.socket.destroy();r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({released:true,operatorAttested:false}));
    });
    const config={origin:await listen(proxy),adminToken:'admin',clientToken:'client'},op=parseOperation({action:'recover-job-hold',...identity,confirmStopped:true,typedGpuUuid:hold.gpuUuid});
    assert.deepEqual(await executeOperation(config,op),{status:409,outcome:'state-changed'});assert.equal(posts,0);
    for(mode of ['drop','bad-ack'])assert.deepEqual(await executeOperation(config,op),{status:502,outcome:'uncertain'});
    assert.equal(posts,2);assert.deepEqual(await ctx.database.listJobCleanupHolds(),[hold]);
  }finally{if(proxy?.listening)await close(proxy);await close(core);await ctx.close();}
});
