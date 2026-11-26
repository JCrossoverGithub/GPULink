// Disposable QA only. Real Core HTTP + SQLite, deliberately synthetic worker telemetry.
import {once} from 'node:events';
import {createTestContext,gpu,registerWorker,submitJob} from '../../test/helpers.mjs';
import {createHttpServer} from '../../src/control-plane/http-server.mjs';
import {createManager} from '../gateway.mjs';
const ctx=createTestContext({initialNow:Date.now()});
const core=createHttpServer(ctx);core.listen(0,'127.0.0.1');await once(core,'listening');
const w=await registerWorker(ctx,{name:'qa-atlas',gpus:[gpu({uuid:'GPU-QA-1',name:'QA device 01',memoryTotalMiB:24576,memoryUsedMiB:1024}),gpu({uuid:'GPU-QA-2',index:1,name:'QA device 02',memoryTotalMiB:8192})]});
const j=await submitJob(ctx,{payload:{echo:'test fixture only'}});await ctx.service.startJob(j.id,{workerId:j.assignedWorkerId,leaseId:j.leaseId});await ctx.service.cancelJob(j.id);
await registerWorker(ctx,{name:'qa-orion',gpus:[gpu({uuid:'GPU-QA-3',name:'QA device 03',memoryTotalMiB:8192})]});
await ctx.service.submitSession({projectId:'qa-session',capability:'diagnostic.echo',requirements:{minVramMiB:1}});
const manager=createManager({origin:`http://127.0.0.1:${core.address().port}`,adminToken:ctx.config.tokens.admin,clientToken:ctx.config.tokens.client,fixture:true});
manager.listen(0,'127.0.0.1');await once(manager,'listening');console.log(`http://127.0.0.1:${manager.address().port}/`);
console.log('Isolated QA Core, synthetic telemetry, in-memory SQLite. Ctrl+C closes both.');
let closing=false;async function stop(){if(closing)return;closing=true;process.stdin.pause();for(const s of [manager,core])if(s.listening){s.closeAllConnections();await new Promise(r=>s.close(r));}await ctx.close();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
// QA harness can stop upstream while leaving manager online to exercise stale behavior.
if(process.argv.includes('--qa-disconnect'))process.stdin.on('data',async b=>{if(b.toString().trim()==='disconnect'&&core.listening){core.closeAllConnections();await new Promise(r=>core.close(r));console.log('QA Core stopped');}});
