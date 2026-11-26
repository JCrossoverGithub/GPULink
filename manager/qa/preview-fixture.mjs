// Disposable QA only. Real Core HTTP + SQLite, deliberately synthetic worker telemetry.
import {once} from 'node:events';
import {createTestContext,gpu,registerWorker,submitJob} from '../../test/helpers.mjs';
import {createHttpServer} from '../../src/control-plane/http-server.mjs';
import {createManager} from '../gateway.mjs';
import {adapterHealthReport} from '../../src/shared/adapter-health.mjs';
const ctx=createTestContext({initialNow:Date.now()});
const core=createHttpServer(ctx);await core.startEventNotifications();core.listen(0,'127.0.0.1');await once(core,'listening');
if(!process.argv.includes('--qa-empty')){
const w=await registerWorker(ctx,{name:'qa-atlas',gpus:[gpu({uuid:'GPU-QA-1',name:'QA device 01',memoryTotalMiB:24576,memoryUsedMiB:1024}),gpu({uuid:'GPU-QA-2',index:1,name:'QA device 02',memoryTotalMiB:8192})]});
const j=await submitJob(ctx,{payload:{echo:'test fixture only'}});await ctx.service.startJob(j.id,{workerId:j.assignedWorkerId,leaseId:j.leaseId});await ctx.service.cancelJob(j.id);
await ctx.service.registerWorker({name:'qa-orion',version:'test',labels:{},capabilities:['diagnostic.echo'],warmModels:[],adapterManifests:[{schemaVersion:1,type:'diagnostic.echo',version:'1.0.0',executionMode:'in-process'}],adapterHealth:[adapterHealthReport('diagnostic.echo','ready',ctx.clock())],gpus:[gpu({uuid:'GPU-QA-3',name:'QA device 03',memoryTotalMiB:8192})]});
await ctx.service.submitSession({projectId:'qa-session',capability:'diagnostic.echo',requirements:{minVramMiB:1}});
// Optional extra hosts exercise topology grouping without changing the default fixture.
if(process.argv.includes('--qa-many-hosts'))for(let i=4;i<=6;i++)await registerWorker(ctx,{name:'qa-extra-'+i,gpus:[gpu({uuid:'GPU-QA-'+i,name:'QA device 0'+i,memoryTotalMiB:8192})]});
if(process.argv.includes('--qa-many-hosts'))await ctx.database.appendEvent('constructor',null,{},ctx.clock());
if(process.argv.includes('--enable-controls'))await submitJob(ctx,{projectId:'qa-cancel-demo',constraints:{gpuCount:1,minVramMiB:999999,capabilities:['diagnostic.echo']}});
if(process.argv.includes('--qa-polish'))await submitJob(ctx,{projectId:'qa-cancel-demo',constraints:{gpuCount:1,minVramMiB:999999,capabilities:['diagnostic.echo']}});
// Dedicated recovery scenario: only synthetic execution exists; never use for a live installation.
if(process.argv.includes('--qa-recovery')){await ctx.service.setWorkerDrain(w.id,{drain:true});ctx.advance(ctx.config.heartbeatTimeoutMs+1);await ctx.scheduler.runOnce();}
// Duplicate display labels must not merge or confuse generated registrations.
if(process.argv.includes('--qa-named-workers'))for(const [index,name,label] of [[7,'gpu-'+'a'.repeat(32),'Inference 01'],[8,'gpu-'+'b'.repeat(32),'Inference 01'],[9,'gpu-'+'c'.repeat(32),null]])await ctx.service.registerWorker({name,version:'test',labels:label?{'gpulink.display-name':label}:{},capabilities:['diagnostic.echo'],gpus:[gpu({uuid:'GPU-QA-'+index,name:'QA device 0'+index,memoryTotalMiB:8192})]});
}
const manager=createManager({origin:`http://127.0.0.1:${core.address().port}`,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client,fixture:true,...(process.argv.includes('--qa-empty')?{installation:{kind:'server',name:'qa-empty-server'}}:{}),controls:process.argv.includes('--enable-controls')});
manager.listen(0,'127.0.0.1');await once(manager,'listening');console.log(`http://127.0.0.1:${manager.address().port}/`);
console.log('Isolated QA Core, synthetic telemetry, in-memory SQLite. Ctrl+C closes both.');
let closing=false;async function stop(){if(closing)return;closing=true;process.stdin.pause();for(const s of [manager,core])if(s.listening){s.closeAllConnections();await new Promise(r=>s.close(r));}await core.stopEventNotifications();await ctx.close();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
// QA harness can stop upstream while leaving manager online to exercise stale behavior.
if(process.argv.includes('--qa-disconnect'))process.stdin.on('data',async b=>{if(b.toString().trim()==='event'&&core.listening){await ctx.database.appendEvent('qa.updated',null,{},Date.now());console.log('QA event committed');}else if(b.toString().trim()==='disconnect'&&core.listening){core.closeAllConnections();await new Promise(r=>core.close(r));console.log('QA Core stopped');}});
