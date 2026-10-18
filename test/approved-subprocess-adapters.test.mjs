import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from '../src/worker/config.mjs';
import { loadApprovedSubprocessSessionAdapters } from '../src/worker/approved-subprocess-adapters.mjs';

const manifest = Object.freeze({ schemaVersion: 2, type: 'example.subprocess.echo',
  adapterId: 'example.subprocess.echo.v1', version:'1.0.0', executionMode:'streaming-gateway' });
const sha = b => createHash('sha256').update(b).digest('hex');

async function fixture(fn) {
  const tmp = await mkdtemp(path.join(tmpdir(),'gpulink-dp3c2b-'));
  try {
    const pyProbe = spawnSync('python3', ['-c','import sys; print(sys.executable)'], {encoding:'utf8'});
    if (pyProbe.status !== 0) throw new Error('python3 required by DP3C2B test');
    const executable = realpathSync(existsSync('/usr/bin/python3') ? '/usr/bin/python3' : pyProbe.stdout.trim());
    const python = await readFile(executable);
    const script = path.join(tmp,'echo.py');
    const scriptBytes = await readFile(fileURLToPath(new URL('../examples/external-adapter/echo-subprocess.py', import.meta.url)));
    await writeFile(script,scriptBytes,{mode:0o600});
    const catalog = path.join(tmp,'catalog.json');
    const spec = {
      manifest,
      command:{ executable, sha256:sha(python), args:['-I','-B',script],
        assets:[{path:script, sha256:sha(scriptBytes)}] },
    };
    const put = async (items=[spec]) => writeFile(catalog, JSON.stringify({schemaVersion:1,adapters:items}),{mode:0o600});
    await put();
    return await fn({catalog,script,spec,put,tmp});
  } finally { await rm(tmp,{recursive:true,force:true}); }
}

class EchoSocket extends EventEmitter {
  readyState=1;
  bufferedAmount=0;
  constructor(){super();this.writes=[];}
  send(data,options,callback){this.writes.push({bytes:Buffer.from(data),binary:options.binary});this.emit('sent');callback?.(null);}
  close(){this.readyState=3;this.emit('close');}
}

function received(socket,count,timeout=2000){
  return new Promise((resolve,reject)=>{
    const tm = setTimeout(()=>{socket.removeListener('sent', check);reject(new Error('echo timeout'));},timeout);
    function check(){if(socket.writes.length >= count){clearTimeout(tm);socket.removeListener('sent',check);resolve(socket.writes);}}
    socket.on('sent',check);check();
  });
}

test('catalog is default-disabled; config requires operator absolute path',async()=>{
  assert.deepEqual(await loadApprovedSubprocessSessionAdapters(),[]);
  const env={GPULINK_WORKER_NAME:'test',GPULINK_WORKER_TOKEN:'a'.repeat(32)};
  assert.equal(loadWorkerConfig(env).approvedSubprocessCatalogPath,null);
  assert.equal(loadWorkerConfig({...env,GPULINK_APPROVED_SUBPROCESS_CATALOG_PATH:'/tmp/a.json'}).approvedSubprocessCatalogPath,'/tmp/a.json');
  assert.throws(()=>loadWorkerConfig({...env,GPULINK_APPROVED_SUBPROCESS_CATALOG_PATH:'relative'}),/absolute path/);
});

test('operator-pinned Python subprocess echoes binary and text over generic socket', async()=>{
  await fixture(async ({catalog})=>{
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    assert.deepEqual(adapter.manifest,manifest);
    assert.equal(await adapter.readinessProbe(),true);
    const socket = new EchoSocket();
    const controller = new AbortController();
    const task = adapter.handleSession({id:'session_DP3C2B'}, {signal:controller.signal,dataPlaneSocket:socket});
    // Race intentionally: client may send immediately after relay pairing.
    socket.emit('message', Buffer.from([0,255,13,42]),true);
    socket.emit('message', Buffer.from('hello world'),false);
    const writes = await received(socket,2);
    assert.deepEqual(writes.map(w=>w.binary),[true,false]);
    assert.deepEqual(writes[0].bytes,Buffer.from([0,255,13,42]));
    assert.equal(writes[1].bytes.toString(),'hello world');
    socket.close();
    await task;
  });
});

test('parent lease cancellation reaps subprocess and does not infer completed job',async()=>{
  await fixture(async ({catalog})=>{
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    const socket = new EchoSocket();
    const controller = new AbortController();
    const task = adapter.handleSession({id:'session_cancel'}, {signal:controller.signal,dataPlaneSocket:socket});
    controller.abort();
    await task;
    assert.equal(socket.writes.length,0);
  });
});

test('invalid input UTF-8 is not silently substituted', async()=>{
  await fixture(async ({catalog})=>{
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    const socket = new EchoSocket();
    const controller = new AbortController();
    const task = adapter.handleSession({id:'session_bad_text'}, {signal:controller.signal,dataPlaneSocket:socket});
    socket.emit('message', Buffer.from([0xff]), false);
    await assert.rejects(task);
    assert.equal(socket.writes.length,0);
  });
});

test('adapter rejects catalog fields outside the operator contract',async()=>{
  await fixture(async ({catalog,spec})=>{
    await writeFile(catalog,JSON.stringify({schemaVersion:1,adapters:[{...spec, clientArgs:['-x']}]}));
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),{code:'adapter_spec_schema'});
  });
});

test('duplicate adapter IDs are rejected',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([spec,spec]);
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),{code:'duplicate_adapter_id'});
  });
});

test('unapproved absolute executable arguments are rejected',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,command:{...spec.command,args:['/tmp/evil.py']}}]);
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),{code:'unapproved_absolute_argument'});
  });
});

test('tampering with pinned source fails closed, including on readiness recheck',async()=>{
  await fixture(async ({catalog,script})=>{
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    assert.equal(await adapter.readinessProbe(),true);
    await writeFile(script,'print("bad")');
    assert.equal(await adapter.readinessProbe(),false);
    await assert.rejects(adapter.handleSession({id:'session_mutated'}, {
      signal:new AbortController().signal,dataPlaneSocket:new EchoSocket(),
    }),{code:'approved_file_hash_mismatch'});
  });
});

test('a pinned symlink asset is rejected',async()=>{
  if(process.platform==='win32')return;
  await fixture(async ({catalog,script,spec,put,tmp})=>{
    const link=path.join(tmp,'link.py');await symlink(script,link);
    await put([{...spec,command:{...spec.command,args:['-I',link],assets:[{...spec.command.assets[0],path:link}]}}]);
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog));
  });
});

test('world-writable approved asset is rejected',async()=>{
  if(process.platform==='win32')return;
  await fixture(async ({catalog,script})=>{
    await chmod(script,0o666);
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),{code:'approved_file_permissions'});
  });
});

test('oversized input fails closed without forwarding any child data',async()=>{
  await fixture(async ({catalog})=>{
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const controller=new AbortController();
    const task=adapter.handleSession({id:'session_oversize'}, {signal:controller.signal,dataPlaneSocket:socket});
    socket.emit('message',Buffer.alloc(65537),true);
    await task;
    assert.equal(socket.writes.length,0);
  });
});

test('explicit completion requires exact opt-in and rejects unsupported modes',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'unknown'}]);
    await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),{code:'unsupported_completion_mode'});
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    assert.equal(await adapter.readinessProbe(),true);
  });
});

test('legacy opaque adapters forward the reserved end text without interpreting it',async()=>{
  await fixture(async ({catalog})=>{
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_opaque_end'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    const text=Buffer.from('{"type":"gpulink.session.end.v1"}');
    socket.emit('message',text,false);
    const messages=await received(socket,1);
    assert.deepEqual(messages[0],{bytes:text,binary:false});
    socket.close();
    await task;
  });
});

test('explicit text END drains preceding opaque frames, ACKs only after child success, and returns',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_explicit_complete'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    // Queue all frames before the subprocess handshake completes.
    socket.emit('message',Buffer.from([0,255,13,42]),true);
    socket.emit('message',Buffer.from('hello'),false);
    socket.emit('message',Buffer.from('{"type":"gpulink.session.end.v1"}'),false);
    await task;
    assert.deepEqual(socket.writes.map(x=>x.binary),[true,false,false]);
    assert.deepEqual(socket.writes[0].bytes,Buffer.from([0,255,13,42]));
    assert.equal(socket.writes[1].bytes.toString(),'hello');
    assert.equal(socket.writes[2].bytes.toString(),'{"type":"gpulink.session.completed.v1"}');
  });
});

test('binary bytes that look like END remain opaque binary',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_binary_opaque'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('{"type":"gpulink.session.end.v1"}'),true);
    const messages=await received(socket,1);
    assert.equal(messages[0].binary,true);
    socket.close();
    await task;
  });
});

test('client data after END fails closed without completion acknowledgment',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_bad_after_end'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('{"type":"gpulink.session.end.v1"}'),false);
    socket.emit('message',Buffer.from('unexpected'),false);
    await task;
    assert.equal(socket.writes.some(x=>x.bytes.toString().includes('completed.v1')),false);
  });
});

test('disconnect before END always cancels, never acknowledges completion',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_drop_before_end'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('data'),false);
    await received(socket,1);
    socket.close();
    await task;
    assert.equal(socket.writes.some(x=>x.bytes.toString().includes('completed.v1')),false);
  });
});

test('an adapter that acknowledges END but does not exit successfully cannot complete',async()=>{
  await fixture(async ({put,spec,catalog,script})=>{
    const source=await readFile(script,'utf8');
    const normalized=source.replace(/\r\n/gu,'\n');
    const broken=normalized.replace('send(END)\n            return 0', 'send(END)\n            return 2');
    assert.notEqual(normalized,broken);
    await writeFile(script,broken);
    await put([{...spec,completionMode:'explicit-text-v1',command:{...spec.command,
      assets:[{path:script,sha256:sha(Buffer.from(broken))}]}}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_child_failed_after_ack'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('{"type":"gpulink.session.end.v1"}'),false);
    await assert.rejects(task);
    assert.equal(socket.writes.some(x=>x.bytes.toString().includes('completed.v1')),false);
  });
});


test('client completion-ack spoof attempt fails closed',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_no_spoof'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('{"type":"gpulink.session.completed.v1"}'),false);
    await task;
    assert.equal(socket.writes.length,0);
  });
});

test('a completion acknowledgment transport error cannot report success',async()=>{
  await fixture(async ({put,spec,catalog})=>{
    await put([{...spec,completionMode:'explicit-text-v1'}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    class FailCompletionSocket extends EchoSocket {
      send(data, opts, callback) {
        if (Buffer.from(data).equals(Buffer.from('{"type":"gpulink.session.completed.v1"}'))) {
          callback?.(new Error('simulated socket failure')); return;
        }
        super.send(data,opts,callback);
      }
    }
    const socket=new FailCompletionSocket();
    const task=adapter.handleSession({id:'session_ack_transport_failure'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('{"type":"gpulink.session.end.v1"}'),false);
    await assert.rejects(task,{code:'completion_ack_failed'});
    assert.equal(socket.writes.some(x=>x.bytes.toString().includes('completed.v1')),false);
  });
});

test('subprocess cannot spoof a worker completion acknowledgment via its output',async()=>{
  await fixture(async ({put,spec,catalog,script})=>{
    const source=await readFile(script,'utf8');
    const forged=source.replace('send(kind, payload)',
      'send(TEXT, b\'{"type":"gpulink.session.completed.v1"}\')');
    assert.notEqual(source,forged);
    await writeFile(script,forged);
    await put([{...spec,completionMode:'explicit-text-v1',command:{...spec.command,
      assets:[{path:script,sha256:sha(Buffer.from(forged))}]}}]);
    const [adapter]=await loadApprovedSubprocessSessionAdapters(catalog);
    const socket=new EchoSocket();
    const task=adapter.handleSession({id:'session_subprocess_spoof'}, {
      signal:new AbortController().signal,dataPlaneSocket:socket,
    });
    socket.emit('message',Buffer.from('cause spoof'),false);
    await task;
    assert.equal(socket.writes.some(x=>x.bytes.toString().includes('completed.v1')),false);
  });
});


test('operator-only catalog session timeout is strictly bounded and opt-in', async () => {
  await fixture(async ({put, spec, catalog}) => {
    for (const value of [null, 0, -1, 900_001, 1.5, '720000']) {
      await put([{...spec, executionLimits: {sessionTimeoutMs: value}}]);
      await assert.rejects(loadApprovedSubprocessSessionAdapters(catalog),
        {code:'invalid_execution_limits'});
    }
    await put([{...spec, executionLimits: {sessionTimeoutMs: 720_000}}]);
    const [adapter] = await loadApprovedSubprocessSessionAdapters(catalog);
    assert.equal(await adapter.readinessProbe(), true);
    // Legacy catalogs without executionLimits must remain valid.
    await put([spec]);
    assert.equal((await loadApprovedSubprocessSessionAdapters(catalog)).length, 1);
  });
});
