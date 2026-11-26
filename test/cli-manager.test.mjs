import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {selectManagerDirectory,managerOptions,browserCommand,runManager} from '../src/cli/manager.mjs';
import {createLocalSetup} from '../src/cli/local-init.mjs';
import {createManager} from '../manager/gateway.mjs';
import {executeOperation} from '../manager/operations.mjs';
import {createTestContext,registerWorker} from './helpers.mjs';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`;};
const close=async s=>{s.closeEventStreams?.();s.closeAllConnections();await new Promise(r=>s.close(r));};
const headers={'X-GPULink-Manager':'snapshot-v1'};
function scratch(t){const root=mkdtempSync(path.join(tmpdir(),'gpl-mgr-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('Manager chooses one explicit or unambiguous default installation, never CWD',t=>{
  const root=scratch(t),local=path.join(root,'local'),server=path.join(root,'server');
  assert.throws(()=>selectManagerDirectory(null,local,server),/No default installation/);
  mkdirSync(server);assert.equal(selectManagerDirectory(null,local,server),server);
  mkdirSync(local);assert.throws(()=>selectManagerDirectory(null,local,server),/Both default installations/);
  assert.equal(selectManagerDirectory(local,local,server),local);
});
test('Manager options are read-only by default; browser launch is fixed, headless and SSH safe',()=>{
  assert.deepEqual(managerOptions([]),{controls:false,open:true});
  assert.deepEqual(managerOptions(['--enable-controls','--no-open']),{controls:true,open:false});
  assert.deepEqual(managerOptions(['--help']),{help:true});
  for(const args of [['--enable-controls','--enable-controls'],['--host','0.0.0.0'],['--help','--no-open']])assert.throws(()=>managerOptions(args),/Usage/);
  assert.equal(browserCommand({},'linux-microsoft-standard-WSL2'),'explorer.exe');
  assert.equal(browserCommand({WAYLAND_DISPLAY:'wayland-0'},'linux'),'xdg-open');
  assert.equal(browserCommand({SSH_CONNECTION:'test',DISPLAY:':0'},'microsoft'),null);
  assert.equal(browserCommand({},'linux'),null);
});
test('Manager refuses a generated but stopped installation before opening a browser or listener',async t=>{
  const root=scratch(t),dir=path.join(root,'a');createLocalSetup(dir);
  const lines=[],output={log:s=>lines.push(s),error:s=>lines.push(s)};
  assert.equal(await runManager(['--no-open'],dir,{output}),1);
  assert.ok(lines.every(s=>!s.startsWith('http://')));
});
test('ownership guard blocks snapshot and SSE upstream authorization, including reconnect after refusal', {timeout:12000},async()=>{
  const ctx=createTestContext();const core=createHttpServer(ctx);let manager;const ctl=new AbortController();
  let allow=false,requests=0;
  try{
    const origin=await listen(core);await core.startEventNotifications();core.on('request',()=>requests++);
    manager=createManager({origin,adminToken:ctx.config.tokens.admin,assertCore:async()=>{if(!allow)throw Error('ownership not verified');}});
    const url=await listen(manager);
    assert.equal((await fetch(url+'/api/snapshot',{headers})).status,503);assert.equal(requests,0);
    const r=await fetch(url+'/api/changes',{headers,signal:ctl.signal});const reader=r.body.getReader();
    const text=()=>reader.read().then(x=>Buffer.from(x.value).toString());
    assert.match(await text(),/event: fallback/);assert.equal(requests,0);
    allow=true;let ready=false;
    while(!ready){const frame=await text();ready=frame.includes('event: ready');}
    assert.equal(requests,1);
    assert.equal((await fetch(url+'/api/snapshot',{headers})).status,200);
    allow=false;await core.stopEventNotifications();
    // Wait for the existing stream to observe closure; the next attempt must not send a credential.
    const deadline=performance.now()+4500;
    while(performance.now()<deadline){const next=await text();if(next.includes('event: fallback'))break;}
    const old=requests;await new Promise(r=>setTimeout(r,2300));assert.equal(requests,old);
    ctl.abort();
  }finally{ctl.abort();if(manager)await close(manager);await core.stopEventNotifications();await close(core);await ctx.close();}
});
test('ownership lost between operation preflight and dispatch refuses mutation',async()=>{
  const ctx=createTestContext();const core=createHttpServer(ctx);let checks=0,posts=0;
  try{
    const worker=await registerWorker(ctx,{name:'guard-test-worker',gpus:[]});const origin=await listen(core);core.on('request',req=>{if(req.method==='POST')posts++;});
    const result=await executeOperation({origin,adminToken:ctx.config.tokens.admin,assertCore:async()=>{if(++checks>1)throw Error('ownership lost');}}, {action:'drain',id:worker.id,expected:false});
    assert.deepEqual(result,{status:503,outcome:'not-dispatched'});assert.equal(posts,0);
  }finally{await close(core);await ctx.close();}
});
