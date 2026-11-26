import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createTestContext} from './helpers.mjs';
import {createHttpServer} from '../src/control-plane/http-server.mjs';
import {createManager} from '../manager/gateway.mjs';
import {createRefreshController} from '../manager/public/refresh-controller.js';
import {createSignalHub,signalFrame} from '../src/shared/change-signals.mjs';
const headers={'X-GPULink-Manager':'snapshot-v1'};
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`;};
const close=async s=>{if(!s.listening)return;s.closeEventStreams?.();s.closeAllConnections();await new Promise(r=>s.close(r));};
const wait=async predicate=>{const until=performance.now()+6000;while(!predicate()){if(performance.now()>until)throw Error('timed out waiting for condition');await new Promise(r=>setTimeout(r,10));}};
async function stream(url,opts={}){
  const controller=new AbortController();const frames=[];let response;
  const done=fetch(url,{...opts,signal:controller.signal}).then(async r=>{
    response=r;let buffer='';const decoder=new TextDecoder();
    for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){frames.push(buffer.slice(0,end+2));buffer=buffer.slice(end+2);}}
  }).catch(e=>{if(!controller.signal.aborted)throw e;});
  await wait(()=>response);assert.equal(response.status,200);
  return {frames,async stop(){controller.abort();await done;}};
}

test('real committed Core events invalidate a shared read-only manager stream, never replay payloads', {timeout:15000},async()=>{
  const ctx=createTestContext();const core=createHttpServer(ctx);let manager;const streams=[];
  try{
    const origin=await listen(core);const route=origin+'/v1/admin/operational-changes';
    for(const token of [undefined,ctx.config.tokens.client,ctx.config.tokens.worker])assert.equal((await fetch(route,{headers:token?{Authorization:'Bearer '+token}:{}})).status,401);
    const admin={Authorization:'Bearer '+ctx.config.tokens.admin};assert.equal((await fetch(route,{headers:admin})).status,503);
    await core.startEventNotifications();
    await ctx.database.appendEvent('qa.old',null,{secret:'PRIVATE-OLD'},ctx.clock());
    let upstream=0;core.on('request',q=>{if(q.url==='/v1/admin/operational-changes')upstream++;});
    manager=createManager({origin,adminToken:ctx.config.tokens.admin});const url=await listen(manager);
    for(const h of [{},{...headers,Origin:'https://evil.example'},{...headers,'Sec-Fetch-Site':'cross-site'}])assert.equal((await fetch(url+'/api/changes',{headers:h})).status,403);
    assert.equal((await fetch(url+'/api/changes',{method:'POST',headers})).status,405);
    for(let i=0;i<2;i++)streams.push(await stream(url+'/api/changes',{headers:i?{'Sec-Fetch-Site':'same-origin'}:headers}));
    await wait(()=>streams.every(s=>s.frames.includes(signalFrame('ready'))));assert.equal(upstream,1);
    const get=async()=>await (await fetch(url+'/api/snapshot',{headers})).json();
    const before=await get();assert.ok(before.events.some(e=>e.type==='qa.old'));
    await assert.rejects(ctx.database.transaction(async t=>{await t.appendEvent('qa.rollback',null,{},ctx.clock());throw Error('rollback');}));
    await new Promise(r=>setTimeout(r,1150));
    assert.ok(streams.every(s=>!s.frames.includes(signalFrame('changed'))));
    for(let i=0;i<5;i++)await ctx.database.appendEvent('qa.new',null,{secret:'PRIVATE-NEW'},ctx.clock());
    await wait(()=>streams.every(s=>s.frames.includes(signalFrame('changed'))));
    assert.ok(streams.every(s=>s.frames.filter(f=>f===signalFrame('changed')).length===1));
    assert.ok(streams.every(s=>s.frames.every(f=>[signalFrame('ready'),signalFrame('fallback'),signalFrame('changed'),signalFrame('heartbeat')].includes(f))));
    const after=await get();assert.equal(after.events.filter(e=>e.type==='qa.new').length,5);assert.ok(!JSON.stringify(after).includes('PRIVATE-NEW'));assert.ok(!after.events.some(e=>e.type==='qa.rollback'));
    await core.stopEventNotifications();await wait(()=>streams.every(s=>s.frames.at(-1)===signalFrame('fallback')));
    await ctx.database.appendEvent('qa.missed',null,{},ctx.clock());await core.startEventNotifications();
    await wait(()=>streams.every(s=>s.frames.at(-1)===signalFrame('ready')));
    assert.equal(upstream,2);assert.ok((await get()).events.some(e=>e.type==='qa.missed'));
  }finally{await Promise.all(streams.map(s=>s.stop()));if(manager)await close(manager);await core.stopEventNotifications();await close(core);await ctx.close();}
});

test('invalid upstream frame stays private; redirect is refused; reconnect reconciles cache even during an inflight snapshot',{timeout:15000},async()=>{
  const ctx=createTestContext();let manager,sub;let mode='redirect',upstream=0,redirectHits=0,snapshotHits=0,hold=null,upstreamResponse;
  const redirect=http.createServer((q,r)=>{redirectHits++;r.end();});const target=await listen(redirect);
  const core=http.createServer(async(q,r)=>{
    if(q.url==='/v1/admin/operational-changes'){
      upstream++;assert.equal(q.headers.authorization,'Bearer admin-test');
      if(mode==='redirect'){r.writeHead(302,{Location:target});r.end();return;}
      r.writeHead(200,{'Content-Type':'text/event-stream'});upstreamResponse=r;r.write(signalFrame('ready'));
      if(mode==='invalid')r.write('event: secret\ndata: PRIVATE-UPSTREAM\n\n');return;
    }
    if(q.url==='/v1/admin/operational-snapshot'){
      snapshotHits++;const body=JSON.stringify(await ctx.database.readOperationalState(ctx.clock,60000));
      if(mode==='hold'){hold=()=>{if(r.headersSent||r.destroyed)return;r.writeHead(200,{'Content-Type':'application/json'});r.end(body);};return;}
      r.writeHead(200,{'Content-Type':'application/json'});r.end(body);return;
    }
    r.writeHead(404);r.end();
  });
  try{
    const origin=await listen(core);manager=createManager({origin,adminToken:'admin-test'},{monotonicNow:()=>0});const url=await listen(manager);
    sub=await stream(url+'/api/changes',{headers});await wait(()=>upstream===1);assert.equal(redirectHits,0);
    mode='invalid';await wait(()=>upstream===2&&sub.frames.includes(signalFrame('ready'))&&sub.frames.at(-1)===signalFrame('fallback'));assert.ok(!sub.frames.join('').includes('PRIVATE-UPSTREAM'));
    mode='good';await wait(()=>upstream===3&&sub.frames.at(-1)===signalFrame('ready'));
    const get=async()=>await (await fetch(url+'/api/snapshot',{headers})).json();
    mode='hold';const pending=get();await wait(()=>hold!==null);
    await ctx.database.appendEvent('qa.new',null,{},ctx.clock());upstreamResponse.write(signalFrame('changed'));await wait(()=>sub.frames.at(-1)===signalFrame('changed'));
    mode='good';hold();assert.ok(!(await pending).events.some(e=>e.type==='qa.new'));
    assert.ok((await get()).events.some(e=>e.type==='qa.new'));assert.equal(snapshotHits,2);await get();assert.equal(snapshotHits,2);
  }finally{if(hold)hold();if(sub)await sub.stop();if(manager)await close(manager);await close(core);await close(redirect);await ctx.close();}
});

test('refresh controller coalesces bursts, preserves trailing invalidations and polls after failure',async()=>{
  let now=0,id=0;const tasks=new Map(),reads=[],applied=[];
  const c=createRefreshController({now:()=>now,schedule:(fn,delay)=>{tasks.set(++id,{fn,at:now+delay});return id;},cancel:i=>tasks.delete(i),read:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),apply:(v,e)=>applied.push([v,e])});
  const advance=async time=>{now=time;for(const [i,t] of [...tasks])if(t.at<=now){tasks.delete(i);t.fn();}await Promise.resolve();};
  c.request();c.request();await advance(0);assert.equal(reads.length,1);
  c.request();c.request();await advance(500);assert.equal(reads.length,1);
  reads[0].resolve('first');await Promise.resolve();await advance(999);assert.equal(reads.length,1);await advance(1000);assert.equal(reads.length,2);
  reads[1].reject(Error('offline'));await Promise.resolve();assert.equal(applied[1][1].message,'offline');await advance(5999);assert.equal(reads.length,2);await advance(6000);assert.equal(reads.length,3);
  reads[2].resolve('recovered');await Promise.resolve();assert.equal(applied[2][0],'recovered');c.stop();await advance(20000);assert.equal(reads.length,3);
});

// The hub itself bounds clients, emits heartbeats and drops backpressured
// consumers instead of keeping an unbounded outgoing queue.
test('signal hub bounds clients, coalesces changes and drops backpressure',async()=>{
  const {EventEmitter}=await import('node:events');
  const counts=[];const hub=createSignalHub({maxClients:2,heartbeatMs:20,changeIntervalMs:10,onCount:n=>counts.push(n)});
  const response=()=>Object.assign(new EventEmitter(),{frames:[],destroyed:false,writableEnded:false,blocked:false,writeHead(){},write(s){this.frames.push(s);return !this.blocked;},destroy(){this.destroyed=true;this.emit('close');},end(){this.writableEnded=true;this.emit('close');}});
  const a=response(),b=response(),c=response();
  try{assert.ok(hub.add(a));assert.ok(hub.add(b));assert.equal(hub.add(c),false);assert.equal(hub.size,2);
    hub.changed();hub.changed();b.blocked=true;await wait(()=>a.frames.includes(signalFrame('changed')));assert.equal(a.frames.filter(f=>f===signalFrame('changed')).length,1);assert.equal(b.destroyed,true);assert.equal(hub.size,1);
    await wait(()=>a.frames.includes(signalFrame('heartbeat')));
  }finally{hub.close();}
  assert.equal(hub.size,0);assert.equal(counts.at(-1),0);assert.equal(a.writableEnded,true);
});
