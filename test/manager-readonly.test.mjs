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
import {collectOperationalState,normalizeOperationalSnapshot} from '../src/shared/operational-snapshot.mjs';
import {ControlPlaneDatabase} from '../src/control-plane/database.mjs';
import {SqlitePersistence} from '../src/control-plane/persistence/sqlite.mjs';
import {Scheduler} from '../src/control-plane/scheduler.mjs';
import {ControlPlaneService} from '../src/control-plane/service.mjs';
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
    let cacheTime=0;
    manager=createManager({origin,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client},{monotonicNow:()=>cacheTime});const url=await listen(manager);
    const response=await fetch(url+'/api/snapshot',{headers});assert.equal(response.status,200);const text=await response.text(),s=JSON.parse(text);
    assert.equal(s.schemaVersion,2);assert.equal(s.atomic,true);assert.equal(s.eligibility,'not-evaluated');assert.equal(s.workers[0].id,w.id);assert.equal(s.workers[0].gpus.length,2);assert.equal(s.jobs.find(x=>x.id===j.id).status,'cancelled');assert.equal(s.sessions.find(x=>x.id===session.id).status,'allocated');assert.equal(s.holds[0].gpuUuid,j.assignedGpuUuid);assert.equal(s.coverage.holds,'all-scheduler-fences');assert.equal(s.devices.find(d=>d.gpuUuid===j.assignedGpuUuid).state,'job-cleanup-hold');assert.equal(s.devices.find(d=>d.gpuUuid===session.assignedGpuUuid).state,'allocated');assert.ok(s.events.some(e=>e.subjectId===j.id));assert.ok(s.events.every(e=>!('payload' in e)));
    for(const token of [ctx.config.tokens.worker,ctx.config.tokens.client])assert.equal((await fetch(origin+'/v1/admin/operational-snapshot',{headers:{Authorization:'Bearer '+token}})).status,401);
    assert.equal((await fetch(origin+'/v1/admin/operational-snapshot')).status,401);
    for(const secret of [...Object.values(ctx.config.tokens),j.leaseId,'PRIVATE-PAYLOAD-MARKER','PRIVATE-METADATA-MARKER','"leaseId"','"payload"','"metadata"','"result"','"baseUrl"','"labels"'])assert.ok(!text.includes(secret),`leaked forbidden field`);
    assert.equal((await fetch(url+'/api/snapshot')).status,403);assert.equal((await fetch(url+'/api/snapshot',{headers:{...headers,Origin:'https://other.example'}})).status,403);assert.equal((await fetch(url+'/api/snapshot',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(url+'/v1/jobs',{headers})).status,404);assert.equal((await fetch(url+'/api/snapshot',{method:'POST',headers})).status,405);assert.equal((await fetch(url+'/api/snapshot?path=/v1/jobs',{headers})).status,404);
    const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(url+'/',{headers:{Host:'attacker.test'}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);});assert.equal(hostStatus,403);
    const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('access-control-allow-origin'),null);assert.ok(!(await page.text()).includes('SIMULATED DATA'));
    assert.equal((await ctx.database.getJob(j.id)).status,'cancelled');assert.equal((await ctx.database.listJobCleanupHolds()).length,1);
    await close(core);
    // Cache may serve the last successful sample only within its explicit TTL.
    cacheTime=999;
    const cached=await fetch(url+'/api/snapshot',{headers});assert.equal(cached.status,200);assert.deepEqual(await cached.json(),s);
    cacheTime=1000;
    const unavailable=await fetch(url+'/api/snapshot',{headers});assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'core_unavailable_or_invalid'});
    // An unsuccessful refresh must not renew the cache or resurrect old data.
    cacheTime=1001;
    assert.equal((await fetch(url+'/api/snapshot',{headers})).status,503);
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
test('atomic collector retains all active work outside bounded history and latest event headers',async()=>{
  const now=1700000000000,make=(i,status)=>({id:`job-${i}`,projectId:'qa',type:'diagnostic.echo',status,assignedWorkerId:status==='running'?'worker-a':null,assignedGpuUuid:status==='running'?`GPU-${i}`:null,createdAt:now,updatedAt:now,attempt:0,maxAttempts:1,constraints:{minVramMiB:1},payload:{private:'not projected'}});
  const recent=Array.from({length:501},(_,i)=>make(i,'succeeded'));const active=Array.from({length:501},(_,i)=>make(1000+i,'running'));
  const snapshot=await collectOperationalState({listWorkers:async()=>[],listActiveJobs:async()=>active,listOccupyingSessions:async()=>[],listBlockedGpuResources:async()=>[],listJobCleanupHolds:async()=>[],listJobs:async({status,limit})=>{assert.equal(limit,501);return status?[]:recent;},listSessions:async()=>[],listRecentEventHeaders:async limit=>{assert.equal(limit,201);return Array.from({length:201},(_,i)=>({sequence:201-i,type:'job.queued',subjectId:null,createdAt:now,payload:{private:'not projected'}}));}},()=>now,60000);
  assert.equal(snapshot.jobs.length,1001);assert.equal(snapshot.jobs.filter(j=>j.status==='running').length,501);assert.equal(snapshot.coverage.jobListsCapped,true);assert.equal(snapshot.coverage.sessionListsCapped,false);assert.equal(snapshot.events.length,200);assert.equal(snapshot.events[0].sequence,201);assert.equal(snapshot.coverage.eventsCapped,true);assert.ok(!JSON.stringify(snapshot).includes('not projected'));
  assert.throws(()=>normalizeOperationalSnapshot({...snapshot,atomic:false}));assert.throws(()=>normalizeOperationalSnapshot({...snapshot,events:[...snapshot.events].reverse()}));
  let requests=0;const server=http.createServer((q,r)=>{requests++;assert.equal(q.url,'/v1/admin/operational-snapshot');assert.equal(q.headers.authorization,'Bearer a');r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify(snapshot));});
  const origin=await listen(server);try{assert.deepEqual(await readSnapshot({origin,adminToken:'a'}),snapshot);assert.equal(requests,1);}finally{await close(server);}
});
test('SQLite consistent resource snapshot: UUID allocation, scoped fence, global job hold, stale heartbeat and rollback',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'manager-state-'));const file=path.join(dir,'state.sqlite');
  const db=new SqlitePersistence(file);const raw=new ControlPlaneDatabase(file);let now=1700000000000;const clock=()=>now;const config={heartbeatTimeoutMs:1000,leaseDurationMs:10000,vramSafetyMiB:512};const scheduler=new Scheduler(db,{...config,clock});const service=new ControlPlaneService(db,scheduler,config,{clock});const ctx={database:db,scheduler,service};
  try {
    const w=await registerWorker(ctx,{name:'a',gpus:[gpu({uuid:'GPU-A',memoryTotalMiB:8192}),gpu({uuid:'GPU-B',index:1,memoryTotalMiB:8192}),gpu({uuid:'GPU-C',index:2,memoryTotalMiB:8192})]});
    const j=await submitJob(ctx);await service.startJob(j.id,{workerId:w.id,leaseId:j.leaseId});
    const duplicate=await registerWorker(ctx,{name:'b',gpus:[gpu({uuid:j.assignedGpuUuid,memoryTotalMiB:8192}),gpu({uuid:'GPU-C',index:1,memoryTotalMiB:8192})]});
    const scoped=w.gpus.find(g=>g.uuid!==j.assignedGpuUuid&&g.uuid==='GPU-C')?.uuid||'GPU-C';
    // A broker-style fence is worker/UUID scoped, not a global job hold.
    raw.database.prepare(`INSERT INTO gpu_resource_fences(worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at) VALUES (?,?,1,'quarantined','job','fixture','fixture-lease',?)`).run(w.id,scoped,now);
    let s=await db.readOperationalState(clock,1000);const device=(workerId,gpuUuid)=>s.devices.find(d=>d.workerId===workerId&&d.gpuUuid===gpuUuid);
    assert.equal(device(duplicate.id,j.assignedGpuUuid).state,'allocated');assert.equal(device(duplicate.id,j.assignedGpuUuid).allocations[0].workerId,w.id);
    assert.equal(device(w.id,scoped).state,'safety-fence');assert.equal(device(duplicate.id,scoped).state,'unallocated');
    await service.cancelJob(j.id);s=await db.readOperationalState(clock,1000);assert.equal(device(w.id,j.assignedGpuUuid).state,'job-cleanup-hold');assert.equal(device(duplicate.id,j.assignedGpuUuid).state,'job-cleanup-hold');assert.equal(s.jobs.find(x=>x.id===j.id).status,'cancelled');assert.ok(!JSON.stringify(s).includes(j.leaseId));
    await assert.rejects(db.transaction(async t=>{await t.appendEvent('test.rollback','x',{},now);throw Error('rollback');}),/rollback/);
    now+=1001;s=await db.readOperationalState(clock,1000);assert.equal(device(duplicate.id,scoped).state,'heartbeat-stale');assert.equal(device(duplicate.id,scoped).heartbeatFresh,false);assert.ok(!s.events.some(e=>e.type==='test.rollback'));
    assert.equal((await db.listJobCleanupHolds()).length,1);
  }finally{raw.close();await db.close();rmSync(dir,{recursive:true,force:true});}
});
