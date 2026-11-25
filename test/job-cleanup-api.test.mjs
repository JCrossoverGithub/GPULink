import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {once} from 'node:events';
import {ControlPlaneDatabase} from '../src/control-plane/database.mjs';
import {createTestContext,gpu,registerWorker,submitJob} from './helpers.mjs';

test('cleanup hold endpoints reject client and worker credentials and require exact explicit admin confirmation',async()=>{
  const app=createTestContext({heartbeatTimeoutMs:1000,leaseDurationMs:10000});
  const tokens=app.config.tokens;
  const server=createHttpServer(app);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/v1/admin/job-cleanup-holds`;
  const request=(role,body)=>fetch(url+(body?'/release':''),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${tokens[role]}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try {
    const w=await registerWorker({service:app.service},{name:'cleanup-api-worker',gpus:[gpu({uuid:'GPU-API-HOLD',memoryTotalMiB:8192})]});
    const j=await submitJob({service:app.service});await app.service.startJob(j.id,{workerId:w.id,leaseId:j.leaseId});await app.service.cancelJob(j.id);
    const listed=await request('admin');assert.equal(listed.status,200);const [hold]=(await listed.json()).holds;
    for(const role of ['worker','client']){
      assert.ok([401,403].includes((await request(role)).status));
      assert.ok([401,403].includes((await request(role,{...hold,confirmStopped:true})).status));
    }
    assert.equal((await request('admin',hold)).status,400);
    assert.equal((await request('admin',{...hold,confirmStopped:true})).status,409);
    await app.service.setWorkerDrain(w.id,{drain:true});app.advance(1001);await app.scheduler.runOnce();
    const released=await request('admin',{...hold,confirmStopped:true});assert.equal(released.status,200);assert.deepEqual(await released.json(),{released:true,operatorAttested:true});
    assert.deepEqual((await (await request('admin')).json()).holds,[]);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await app.close();}
});

test('legacy SQLite migration refuses non-clear resource ownership before contacting PostgreSQL',async()=>{
  const {migrateSqliteToPostgres}=await import('../scripts/migrate-sqlite-to-postgres.mjs');
  const dir=mkdtempSync(path.join(tmpdir(),'gpulink-fence-migrate-'));const file=path.join(dir,'source.sqlite');
  const db=new ControlPlaneDatabase(file);
  try {
    const now=1700000000000;
    db.upsertWorker({id:'w',name:'migration-test',version:'test',baseUrl:null,labels:{},capabilities:['diagnostic.echo'],adapterManifests:[],adapterHealth:[],warmModels:[],modelInventory:[],gpus:[],now});
    db.database.prepare(`INSERT INTO gpu_resource_fences(worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at) VALUES('w','gpu',1,'quarantined','job','j','l',?)`).run(now);
  }finally{db.close();}
  try {await assert.rejects(migrateSqliteToPostgres({sourcePath:file,connectionString:'postgresql://test:test@127.0.0.1:1/test'}),/unresolved GPU resource holds/);}
  finally{rmSync(dir,{recursive:true,force:true});}
});
