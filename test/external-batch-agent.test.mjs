import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createControlPlane} from '../src/control-plane/app.mjs';
import {WorkerAgent} from '../src/worker/agent.mjs';
import {loadApprovedSubprocessAdapters} from '../src/worker/approved-subprocess-adapters.mjs';
import {gpu} from './helpers.mjs';
const type='external.batch.agent-test', uuid='GPU-12345678-1234-1234-1234-123456789abc';
const tokens={client:'batch-client-'+ 'c'.repeat(32),worker:'batch-worker-'+ 'w'.repeat(32),admin:'batch-admin-'+ 'a'.repeat(32)};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function until(fn, label) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const result=await fn();if(result)return result;await delay(25);}
  throw new Error(`Timed out: ${label}`);
}
// Uses a real Python subprocess and the existing worker/HTTP pipeline, but a
// fake inventory and a CPU-only payload. Never touches actual CUDA hardware.
test('external batch worker persists result; cancelled live child is reaped and GPU hold remains', {skip:process.platform!=='linux',timeout:30000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'gpl-batch-agent-'));
  let app,agent;
  try {
    const probe=spawnSync(existsSync('/usr/bin/python3')?'/usr/bin/python3':'python3',['-c','import os,sys;print(os.path.realpath(sys.executable))'],{encoding:'utf8'});
    assert.equal(probe.status,0,'Python required for Linux batch integration');
    const executable=realpathSync(probe.stdout.trim());
    const marker=path.join(dir,'pid'); const script=path.join(dir,'batch.py');
    const original=await readFile(new URL('../examples/external-adapter/echo-subprocess.py',import.meta.url),'utf8');
    const program=original.replace('import sys','import sys\nimport os\nimport time').replace('            send(kind, payload)',`            if json.loads(payload).get("wait") is True:\n                with open(${JSON.stringify(marker)}, "w") as f:\n                    f.write(str(os.getpid()))\n                time.sleep(30)\n            send(kind, payload)`);
    await writeFile(script,program,{mode:0o600});
    const catalog=path.join(dir,'catalog.json');
    const manifest={schemaVersion:2,type,adapterId:'test.agent.batch.v1',version:'1.0.0',executionMode:'bounded-process'};
    await writeFile(catalog,JSON.stringify({schemaVersion:1,adapters:[{manifest,command:{executable,sha256:sha(await readFile(executable)),args:['-I','-B',script],assets:[{path:script,sha256:sha(program)}]}}]}),{mode:0o600});
    app=createControlPlane({host:'127.0.0.1',port:0,dataPath:path.join(dir,'state.sqlite'),tokens,heartbeatTimeoutMs:5000,leaseDurationMs:2000,schedulerIntervalMs:20,vramSafetyMiB:512});
    const address=await app.start(); const url=`http://127.0.0.1:${address.port}`;
    agent=new WorkerAgent({controlPlaneUrl:url,token:tokens.worker,name:'external-batch-agent',version:'test',heartbeatIntervalMs:100,assignmentIntervalMs:25,capabilities:['diagnostic.echo'],labels:{},warmModels:[],fakeGpus:[gpu({uuid,memoryTotalMiB:8192})]},{batchAdapters:await loadApprovedSubprocessAdapters(catalog),discoverModelInventory:async()=>[]});
    await agent.start();
    const [w]=await app.database.listWorkers(); assert.ok(w.capabilities.includes(type));assert.deepEqual(w.adapterManifests.find(m=>m.type===type),manifest);
    async function request(method, endpoint, body) {
      const response=await fetch(url+endpoint,{method,headers:{authorization:`Bearer ${tokens.client}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
      assert.ok(response.ok,`HTTP ${response.status}`); return response.json();
    }
    const submit=async payload=>(await request('POST','/v1/jobs',{projectId:'external-batch-agent-test',type,payload,maxAttempts:1})).job;
    const get=async id=>(await request('GET',`/v1/jobs/${id}`)).job;
    const first=await submit({value:'durable'});
    const done=await until(async()=>{const j=await get(first.id);return j.status==='succeeded'&&j;},'batch success');
    assert.deepEqual(done.result,{value:'durable'});assert.equal(done.leaseExpiresAt,null);assert.equal(done.assignedGpuUuid,uuid);
    const live=await submit({wait:true});
    const pid=await until(async()=>{try {return Number(await readFile(marker,'utf8'))||false;}catch(e){if(e.code==='ENOENT')return false;throw e;}},'live child PID');
    assert.equal((await get(live.id)).status,'running');
    assert.equal((await request('POST',`/v1/jobs/${live.id}/cancel`,{})).job.status,'cancelled');
    const blocked=await submit({value:'must not run'}); assert.equal(blocked.status,'queued');
    await until(()=>agent.inFlight.size===0,'worker reaped cancelled child');
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.ok((await app.database.listJobCleanupHolds()).some(h=>h.jobId===live.id&&h.gpuUuid===uuid));
    assert.equal((await get(blocked.id)).status,'queued');
    assert.equal((await get(live.id)).result,null);
  } finally {try {await agent?.stop();}finally{try{await app?.stop();}finally{await rm(dir,{recursive:true,force:true});}}}
});
