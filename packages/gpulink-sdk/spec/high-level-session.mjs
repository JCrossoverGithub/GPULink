import assert from 'node:assert/strict';
import test from 'node:test';
import { GPULinkClient, GPULinkSession, GPULINK_DATA_PLANE_PROTOCOL_V2 } from '../dist/index.js';

const request = {
  projectId: 'external-demo', capability: 'example.streaming',
  requirements: { gpuCount: 1, adapter: 'example.vendor.v1', capabilities: ['example.streaming'] },
};

function fixture(states = ['requested', 'allocated', 'connecting']) {
  const client = new GPULinkClient({ baseUrl: 'https://example.com', token: 'test-token' });
  const calls = { granted: 0, requested: 0, queried: 0, connected: 0, closed: 0, protocol: null, frames: [] };
  let stateIndex = 0;
  let opened = true;
  const listeners = new Set();
  const closeListeners = new Set();
  let closeInfo = null;
  const stream = {
    get isOpen() { return opened; },
    protocol: GPULINK_DATA_PLANE_PROTOCOL_V2,
    get closeInfo() { return closeInfo; },
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
    sendBinary(data) { if (!opened) throw new Error('not open'); calls.frames.push(data); },
    sendText(data) { if (!opened) throw new Error('not open'); calls.frames.push(data); },
    close() { opened = false; },
  };
  client.requestSession = async (body, opts) => {
    assert.equal(body, request);
    assert.deepEqual(opts, {idempotencyKey: undefined});
    calls.requested++;
    return { session: {id:'session-1',status:'requested'}, duplicate:false };
  };
  client.getSession = async (id, options) => {
    assert.equal(id, 'session-1');
    options.signal?.throwIfAborted();
    calls.queried++;
    const state = states[Math.min(stateIndex++, states.length-1)];
    return {session:{id,status:state}};
  };
  client.connectSession = async (id, opts) => {
    assert.equal(id,'session-1');
    calls.connected++;
    calls.protocol = opts.protocolVersion;
    assert.equal(opts.protocolVersion, 2);
    opts.signal?.throwIfAborted();
    return stream;
  };
  client.closeSession = async (id) => {
    assert.equal(id,'session-1');
    calls.closed++;
    return {session:{id,status:'closed'}};
  };
  return {
    client, calls, stream,
    emit: m => { for (const fn of listeners) fn(m); },
    emitClose: (info = {code:1006,reason:'network failure',wasClean:false}) => {
      opened = false; closeInfo = info;
      for (const fn of closeListeners) fn(info);
    },
  };
}

test('openSession waits for worker connection and opts into authenticated v2 relay', async () => {
  const f = fixture();
  const session = await f.client.openSession(request, { allocationTimeoutMs: 1000 });
  assert.ok(session instanceof GPULinkSession);
  assert.equal(session.id, 'session-1');
  assert.equal(f.calls.queried, 3);
  assert.equal(f.calls.connected, 1);
  assert.equal(f.calls.protocol, 2);
  assert.equal(session.protocol, GPULINK_DATA_PLANE_PROTOCOL_V2);
  const messages = [];
  const unsubscribe = session.onMessage(message => messages.push(message));
  f.emit('application-ready-message');
  assert.deepEqual(messages, ['application-ready-message']);
  unsubscribe();
  session.sendBinary(Uint8Array.of(7, 8));
  session.sendText('custom-payload');
  assert.equal(f.calls.frames.length, 2);
  const a = session.close();
  const b = session.close();
  await Promise.all([a,b]);
  assert.equal(f.calls.closed, 1);
  assert.equal(session.isOpen, false);
  assert.throws(() => session.sendText('after-close'), /closing/);
});


test('early adapter frames are buffered in order until a listener subscribes', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  f.emit('model-ready');
  f.emit('partial-1');
  const received = [];
  session.onMessage(message => received.push(message));
  f.emit('partial-2');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['model-ready', 'partial-1', 'partial-2']);
  await session.close();
});

test('terminal session state causes authoritative cleanup; no socket request', async () => {
  const f = fixture(['closed']);
  await assert.rejects(f.client.openSession(request), /ended before worker activation/);
  assert.equal(f.calls.connected, 0);
  assert.equal(f.calls.closed, 1);
});

test('failed pairing causes authoritative cleanup without downgrading the transport', async () => {
  const f = fixture(['connecting']);
  f.client.connectSession = async (_, opts) => {
    assert.equal(opts.protocolVersion, 2);
    throw new Error('pairing failed');
  };
  await assert.rejects(f.client.openSession(request), /pairing failed/);
  assert.equal(f.calls.closed, 1);
});

test('cancelling during allocation closes known server session', async () => {
  const f = fixture(['requested']);
  const abort = new AbortController();
  const promise = f.client.openSession(request, {signal:abort.signal,allocationTimeoutMs:2000});
  setTimeout(() => abort.abort(new Error('client cancelled')), 20);
  await assert.rejects(promise, /client cancelled/);
  assert.equal(f.calls.closed, 1);
  assert.equal(f.calls.connected, 0);
});

test('allocation deadline bounds a worker that never starts', async () => {
  const f = fixture(['allocated']);
  await assert.rejects(f.client.openSession(request, {allocationTimeoutMs:110}), /session allocation deadline exceeded/);
  assert.equal(f.calls.closed, 1);
});

test('abort during session creation is cleaned up after server ID is known', async () => {
  const f = fixture(['connecting']);
  const abort = new AbortController();
  f.client.requestSession = async () => {
    abort.abort(new Error('user aborted while creating'));
    return {session:{id:'session-1',status:'requested'}};
  };
  await assert.rejects(f.client.openSession(request, {signal:abort.signal}), /user aborted while creating/);
  assert.equal(f.calls.closed, 1);
});

test('cleanup failure remains visible alongside original error', async () => {
  const f = fixture(['closed']);
  f.client.closeSession = async () => { throw new Error('close failed'); };
  await assert.rejects(f.client.openSession(request), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
});

test('session close can retry after remote release fails', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  let attempts = 0;
  f.client.closeSession = async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient close failure');
  };
  await assert.rejects(session.close(), /transient close failure/);
  await session.close();
  assert.equal(attempts, 2);
});

test('invalid arguments fail before contacting control plane', async () => {
  const f = fixture(['connecting']);
  await assert.rejects(f.client.openSession(request, {connectTimeoutMs:10}), /connectTimeoutMs/);
  await assert.rejects(f.client.openSession(request, {allocationTimeoutMs:10}), /allocationTimeoutMs/);
  await assert.rejects(f.client.openSession(request, {signal:{}}), /AbortSignal/);
  assert.equal(f.calls.requested, 0);
});


test('inbound overflow is observable, bounded and releases the authoritative session', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  for (let i = 0; i < 257; i++) f.emit('unobserved-' + i);
  assert.equal(session.isOpen, false);
  assert.equal(session.lastError?.code, 'EARLY_BUFFER_OVERFLOW');
  const received = [];
  session.onError(error => received.push(error.code));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['EARLY_BUFFER_OVERFLOW']);
  assert.equal(f.calls.closed, 1);
  await assert.rejects(async () => session.onMessage(() => {}), /closing/);
});

test('throwing application listener cannot interrupt peer listener or incoming socket callback', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  const received = [];
  session.onMessage(() => { throw new Error('credential-laden application exception'); });
  session.onMessage(m => received.push(m));
  session.onError(() => { throw new Error('diagnostic listener exception'); });
  assert.doesNotThrow(() => f.emit('frame'));
  assert.deepEqual(received, ['frame']);
  assert.equal(session.lastError?.code, 'MESSAGE_LISTENER_ERROR');
  assert.ok(!session.lastError.message.includes('credential'));
  await session.close();
});

test('throwing queued listener does not prevent subsequent frame delivery', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  f.emit('early-1'); f.emit('early-2');
  const received = [];
  session.onMessage(() => { throw Error('listener failure'); });
  session.onMessage(m => received.push(m));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['early-1', 'early-2']);
  assert.equal(session.errors.filter(e => e.code === 'MESSAGE_LISTENER_ERROR').length, 2);
  await session.close();
});

test('unexpected relay disconnection releases authoritative lease exactly once', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  const info = {code:1006, reason:'lost connection', wasClean:false};
  const closeEvents = [];
  session.onClose(event => closeEvents.push(event));
  f.emitClose(info);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closeEvents, [info]);
  assert.equal(session.isOpen, false);
  assert.equal(f.calls.closed, 1);
  await session.close();
  assert.equal(f.calls.closed, 1);
});

test('unexpected disconnection exposes authoritative-release failures and permits retry', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  const errors = [];
  session.onError(error => errors.push(error.code));
  let attempt = 0;
  f.client.closeSession = async () => {
    attempt++;
    if (attempt === 1) throw Error('release rejected');
  };
  f.emitClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['REMOTE_RELEASE_FAILED']);
  assert.equal(session.lastError?.code, 'REMOTE_RELEASE_FAILED');
  await session.close();
  assert.equal(attempt, 2);
});

test('application close listener exceptions are isolated and diagnostic remains available', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  const received = [];
  session.onClose(() => { throw Error('faulty consumer'); });
  session.onClose(event => received.push(event.code));
  assert.doesNotThrow(() => f.emitClose());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [1006]);
  assert.equal(session.lastError?.code, 'CLOSE_LISTENER_ERROR');
  assert.equal(f.calls.closed, 1);
});


test('reentrant inbound frames preserve ordering while early queue drains', async () => {
  const f = fixture(['connecting']);
  const session = await f.client.openSession(request);
  f.emit('first'); f.emit('second');
  const received = [];
  session.onMessage(frame => {
    received.push(frame);
    if (frame === 'first') f.emit('third');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['first', 'second', 'third']);
  await session.close();
});
