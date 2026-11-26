import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTestContext,gpu,registerWorker,submitJob} from './helpers.mjs';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {createManager,loadProfile} from '../manager/gateway.mjs';
import {readSnapshot} from '../manager/snapshot.mjs';
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`;};
const close=async s=>{s.closeAllConnections();await new Promise(r=>s.close(r));};
const headers={'X-GPULink-Manager':'snapshot-v1'};
test('real Core HTTP + SQLite: sanitized read-only worker, batch, session and cleanup records',async()=>{
  const ctx=createTestContext({initialNow:Date.now()});const core=createHttpServer(ctx);let manager;
  try{
    const origin=await listen(core);
    const w=await registerWorker(ctx,{name:'<img src=x onerror=alert(1)>',gpus:[gpu({uuid:'GPU-A',memoryTotalMiB:8192}),gpu({uuid:'GPU-B',index:1,memoryTotalMiB:8192})]});
    const j=await submitJob(ctx,{payload:{echo:'PRIVATE-PAYLOAD-MARKER'}});await ctx.service.startJob(j.id,{workerId:w.id,leaseId:j.leaseId});await ctx.service.cancelJob(j.id);
    const {session}=await ctx.service.submitSession({projectId:'live-session',capability:'diagnostic.echo',requirements:{minVramMiB:1},metadata:{secret:'PRIVATE-METADATA-MARKER'}});
    manager=createManager({origin,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client});const url=await listen(manager);
    const response=await fetch(url+'/api/snapshot',{headers});assert.equal(response.status,200);const text=await response.text(),s=JSON.parse(text);
    assert.equal(s.schemaVersion,1);assert.equal(s.atomic,false);assert.equal(s.eligibility,'not-evaluated');assert.equal(s.workers[0].id,w.id);assert.equal(s.workers[0].gpus.length,2);assert.equal(s.jobs.find(x=>x.id===j.id).status,'cancelled');assert.equal(s.sessions.find(x=>x.id===session.id).status,'allocated');assert.equal(s.holds[0].gpuUuid,j.assignedGpuUuid);assert.equal(s.coverage.holds,'job-cleanup-only');
    for(const secret of [...Object.values(ctx.config.tokens),j.leaseId,'PRIVATE-PAYLOAD-MARKER','PRIVATE-METADATA-MARKER','"leaseId"','"payload"','"metadata"','"result"','"baseUrl"','"labels"'])assert.ok(!text.includes(secret),`leaked forbidden field`);
    assert.equal((await fetch(url+'/api/snapshot')).status,403);assert.equal((await fetch(url+'/api/snapshot',{headers:{...headers,Origin:'https://other.example'}})).status,403);assert.equal((await fetch(url+'/api/snapshot',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(url+'/v1/jobs',{headers})).status,404);assert.equal((await fetch(url+'/api/snapshot',{method:'POST',headers})).status,405);assert.equal((await fetch(url+'/api/snapshot?path=/v1/jobs',{headers})).status,404);
    const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(url+'/',{headers:{Host:'attacker.test'}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);});assert.equal(hostStatus,403);
    const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('access-control-allow-origin'),null);assert.ok(!(await page.text()).includes('SIMULATED DATA'));
    assert.equal((await ctx.database.getJob(j.id)).status,'cancelled');assert.equal((await ctx.database.listJobCleanupHolds()).length,1);
    await close(core);await new Promise(r=>setTimeout(r,1050));assert.equal((await fetch(url+'/api/snapshot',{headers})).status,503);
  }finally{if(manager?.listening)await close(manager);if(core.listening)await close(core);await ctx.close();}
});
test('redirect and malformed upstream fail closed; no cross-origin request',async()=>{
  let hits=0;const target=http.createServer((q,r)=>{hits++;r.end('bad');});const other=await listen(target);
  const core=http.createServer((q,r)=>{r.writeHead(302,{Location:other});r.end();});const origin=await listen(core);
  try{await assert.rejects(readSnapshot({origin,adminToken:'a',clientToken:'b'}));assert.equal(hits,0);}finally{await close(core);await close(target);}
  const bad=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('{bad');});const u=await listen(bad);try{await assert.rejects(readSnapshot({origin:u,adminToken:'a',clientToken:'b'}));}finally{await close(bad);}
});
test('private local role profiles reject unsafe modes, symlinks, credential reuse, and non-loopback endpoint',{skip:process.platform!=='linux'},()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'manager-profile-'));const a=path.join(dir,'admin.env'),c=path.join(dir,'client.env');const write=(file,key,val,url='http://127.0.0.1:8088')=>writeFileSync(file,`GPULINK_URL="${url}"\n${key}="${val}"\n`,{mode:0o600});
 try{write(a,'GPULINK_ADMIN_TOKEN','a'.repeat(64));write(c,'GPULINK_CLIENT_TOKEN','b'.repeat(64));assert.equal(loadProfile(dir).origin,'http://127.0.0.1:8088');chmodSync(c,0o644);assert.throws(()=>loadProfile(dir));chmodSync(c,0o600);write(c,'GPULINK_CLIENT_TOKEN','a'.repeat(64));assert.throws(()=>loadProfile(dir));write(c,'GPULINK_CLIENT_TOKEN','b'.repeat(64),'https://example.org');assert.throws(()=>loadProfile(dir));rmSync(c);symlinkSync(a,c);assert.throws(()=>loadProfile(dir));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('bounded status queries retain active records outside recent history and flag possible truncation',async()=>{
 const now=Date.now(),make=(i,status)=>({id:`job-${i}`,projectId:'qa',type:'diagnostic.echo',status,assignedWorkerId:null,assignedGpuUuid:null,createdAt:now,updatedAt:now,attempt:0,maxAttempts:1,constraints:{minVramMiB:1},payload:{private:'not projected'}});
 const recent=Array.from({length:500},(_,i)=>make(i,'succeeded'));const active=make(900,'running');let seen=[];
 const server=http.createServer((q,r)=>{seen.push(q.url);const u=new URL(q.url,'http://localhost');let body;
 if(u.pathname==='/readyz')body={status:'ready'};else if(u.pathname==='/v1/workers')body={workers:[]};else if(u.pathname.endsWith('job-cleanup-holds'))body={holds:[]};else if(u.pathname==='/v1/jobs')body={jobs:!u.searchParams.has('status')?recent:u.searchParams.get('status')==='running'?[active]:[]};else body={sessions:[]};r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify(body));});
 const origin=await listen(server);try{const snapshot=await readSnapshot({origin,adminToken:'a',clientToken:'b'});assert.equal(snapshot.jobs.length,501);assert.equal(snapshot.coverage.jobListsCapped,true);assert.equal(snapshot.coverage.sessionListsCapped,false);assert.ok(snapshot.jobs.some(j=>j.id===active.id));assert.equal(seen.length,12);assert.equal(snapshot.workers.length,0);assert.equal(snapshot.eligibility,'not-evaluated');}finally{await close(server);}
});
