import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createControlPlane } from '../src/control-plane/app.mjs';
import { WorkerAgent } from '../src/worker/agent.mjs';
import { createSyntheticAsrTestAdapter } from '../src/worker/asr-synthetic-test-adapter.mjs';
import {
  DATA_PLANE_PATH,
  DATA_PLANE_SUBPROTOCOL_V2,
  DATA_PLANE_RELAY_READY_V2,
} from '../src/shared/data-plane-contract.mjs';

const CAPABILITY = 'speech.streaming.synthetic';
const ADAPTER_ID = 'gpulink.asr.synthetic-test.v1';
const MODEL_ID = 'example/synthetic-asr';
const REVISION = '0'.repeat(40);
const TOKENS = {
  client: 'phase6a-loopback-only-client-token-123456789',
  worker: 'phase6a-loopback-only-worker-token-123456789',
  admin: 'phase6a-loopback-only-admin-token-123456789',
};
const SCRIPT = fileURLToPath(new URL('../scripts/asr/synthetic_runtime.py', import.meta.url));

function pythonExecutable() {
  for (const cmd of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const result = spawnSync(cmd,
      ['-c', 'import os,sys;print(os.path.realpath(sys.executable))'],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) {
      return result.stdout.trim();
    }
  }
  return null;
}

const PYTHON = pythonExecutable();
assert.ok(PYTHON, 'Phase 6A-5C1 requires an accessible Python interpreter');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, what, timeoutMs = 4_000) {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error(`Timed out: ${what}`);
}

function monitor(socket) {
  const events = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      events.push({ type: '<binary>' });
      return;
    }
    const raw = data.toString('utf8');
    if (raw === DATA_PLANE_RELAY_READY_V2) {
      events.push({ type: DATA_PLANE_RELAY_READY_V2 });
      return;
    }
    try {
      const obj = JSON.parse(raw);
      events.push({ type: obj.type ?? '<unknown>', message: obj });
    } catch {
      events.push({ type: '<unparsed-text>' });
    }
  });
  socket.on('error', () => events.push({ type: '<socket-error>' }));
  socket.on('close', (code) => events.push({ type: '<socket-closed>', code }));
  return events;
}

async function openSocket(socket, timeoutMs = 4_000) {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(); reject(new Error('client WebSocket open timeout'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    }
    function onOpen() { cleanup(); resolve(); }
    function onClose() { cleanup(); reject(new Error('client WebSocket closed before open')); }
    function onError() { cleanup(); reject(new Error('client WebSocket failed to open')); }
    socket.once('open', onOpen);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function audioFrame() {
  const frame = Buffer.alloc(16 + 640 * 2);
  frame.write('ASR1', 0, 'ascii');
  frame.writeUInt32LE(0, 4);
  frame.writeUInt32LE(0, 8);
  frame.writeUInt32LE(640, 12);
  return frame;
}

function sendControl(socket, message) {
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.send(JSON.stringify(message), { binary: false });
}

const start = {
  type: 'asr.start.v1',
  audio: { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 },
};

test('authenticated v2 relay runs a pinned synthetic ASR session through Python',
  { timeout: 20_000 }, async () => {
    const app = createControlPlane({
      host: '127.0.0.1', port: 0, dataPath: ':memory:',
      tokens: TOKENS,
      dataPlaneSigningKey: 'phase6a-e2e-synthetic-fixture-only-signing-key-12345',
      dataPlaneGrantTtlMs: 15_000,
      heartbeatTimeoutMs: 5_000,
      leaseDurationMs: 5_000,
      schedulerIntervalMs: 20,
      vramSafetyMiB: 512,
    });
    const address = await app.start();
    let agent = null;
    let socket = null;
    let submitted = null;
    let events = [];

    try {
      const adapter = createSyntheticAsrTestAdapter({
        testOnly: true, pythonExecutable: PYTHON,
        scriptPath: SCRIPT, modelId: MODEL_ID, revision: REVISION,
      });
      assert.equal(adapter.manifest.type, CAPABILITY);
      assert.equal(adapter.manifest.adapterId, ADAPTER_ID);

      agent = new WorkerAgent({
        controlPlaneUrl: `http://127.0.0.1:${address.port}`,
        token: TOKENS.worker,
        name: 'phase6a-synthetic-e2e-local-only',
        version: 'test',
        heartbeatIntervalMs: 100,
        assignmentIntervalMs: 20,
        capabilityProbeIntervalMs: 100,
        capabilities: [], labels: {}, warmModels: [],
        fakeGpus: [{
          uuid: 'GPU-PHASE6A-SYNTHETIC-E2E',
          index: 0, name: 'Phase 6A Fake GPU',
          memoryTotalMiB: 24_576, memoryUsedMiB: 0,
          utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
        }],
      }, {
        sessionAdapters: [adapter],
        discoverModelInventory: async () => [],
      });
      await agent.start();
      const workers = await app.database.listWorkers();
      assert.equal(workers.length, 1);
      assert.ok(workers[0].adapterManifests.some((m) => m.adapterId === ADAPTER_ID));
      assert.ok(workers[0].adapterHealth.some((m) => m.adapterId === ADAPTER_ID && m.state === 'ready'));

      submitted = (await app.service.submitSession({
        projectId: 'phase6a-synthetic-e2e-local-only',
        capability: CAPABILITY,
        requirements: {
          minVramMiB: 1_000,
          capabilities: [CAPABILITY],
          adapter: ADAPTER_ID,
        },
        recovery: { maxInterruptions: 0 },
      })).session;
      assert.equal(submitted.status, 'allocated');
      assert.equal(submitted.requirements.adapter, ADAPTER_ID);

      await waitUntil(async () => {
        const session = await app.database.getSession(submitted.id);
        return session.status === 'connecting' || session.status === 'active';
      }, 'allocated session entering connecting state');

      const grant = await app.service.issueDataPlaneGrant(submitted.id, 'client');
      socket = new WebSocket(
        `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
        [DATA_PLANE_SUBPROTOCOL_V2, `gpulink.grant.${grant.token}`],
        { perMessageDeflate: false },
      );
      events = monitor(socket);
      await openSocket(socket);
      assert.equal(socket.protocol, DATA_PLANE_SUBPROTOCOL_V2);
      await waitUntil(() => events.some((event) => event.type === DATA_PLANE_RELAY_READY_V2),
        'server-origin relay readiness');
      await waitUntil(() => events.some((event) => event.type === 'asr.model_ready.v1') ||
        events.some((event) => event.type === 'asr.error.v1' || event.type === '<socket-closed>'),
        'application model readiness after relay pairing', 4_000);
      assert.equal(events.some((event) => event.type === 'asr.error.v1'), false,
        `worker returned ASR error: ${JSON.stringify(events)}`);
      const modelReady = events.find((event) => event.type === 'asr.model_ready.v1');
      assert.ok(modelReady,
        `ASR model_ready missing after relay pairing: ${JSON.stringify(events)}`);
      assert.deepEqual(modelReady.message, {
        type: 'asr.model_ready.v1', modelId: MODEL_ID, revision: REVISION,
      });
      assert.ok(events.findIndex((event) => event.type === DATA_PLANE_RELAY_READY_V2) <
        events.findIndex((event) => event.type === 'asr.model_ready.v1'));
      assert.equal((await app.database.getSession(submitted.id)).status, 'active');

      sendControl(socket, start);
      socket.send(audioFrame(), { binary: true });
      sendControl(socket, { type: 'asr.end.v1', lastSequence: 0 });
      await waitUntil(() => events.some((event) => event.type === 'asr.completed.v1') ||
        events.some((event) => event.type === 'asr.error.v1' || event.type === '<socket-closed>'),
        'authenticated synthetic completion', 5_000);
      assert.equal(events.some((event) => event.type === 'asr.error.v1'), false,
        `ASR errored instead of completing: ${JSON.stringify(events)}`);
      assert.deepEqual(events.find((event) => event.type === 'asr.completed.v1')?.message,
        { type: 'asr.completed.v1', lastSequence: 0 },
        `Expected completed terminal event: ${JSON.stringify(events)}`);
      assert.equal(events.some((event) => event.type === 'asr.cancelled.v1'), false);
      console.log('PASS: relay ready, model ready, one PCM frame, completed');
    } finally {
      socket?.terminate();
      if (submitted?.id) {
        try { await app.service.closeSession(submitted.id); } catch { /* already closed */ }
      }
      try { await agent?.stop(); } finally { await app.stop(); }
    }
  });

// Phase 6A-5C2 — same loopback control-plane, real authenticated relay,
// fake GPU and actual supervised synthetic Python process.
// No production registration, model weights or hardware GPU activity.
import { launchSyntheticAsrSession } from '../src/worker/asr-synthetic-session.mjs';

async function limited(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runFailClosedScenario(kind) {
  const app = createControlPlane({
    host: '127.0.0.1', port: 0, dataPath: ':memory:',
    tokens: TOKENS,
    dataPlaneSigningKey: 'phase6a-e2e-negative-only-signing-key-12345',
    dataPlaneGrantTtlMs: 15_000,
    heartbeatTimeoutMs: 5_000,
    leaseDurationMs: 5_000,
    schedulerIntervalMs: 20,
    vramSafetyMiB: 512,
  });
  let agent = null;
  let socket = null;
  let submitted = null;
  const started = [];
  try {
    const address = await app.start();
    const adapter = createSyntheticAsrTestAdapter({
      testOnly: true, pythonExecutable: PYTHON,
      scriptPath: SCRIPT, modelId: MODEL_ID, revision: REVISION,
      launchSession: async (options) => {
        const syntheticSession = await launchSyntheticAsrSession(options);
        started.push(syntheticSession);
        return syntheticSession;
      },
    });
    agent = new WorkerAgent({
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      token: TOKENS.worker,
      name: `phase6a-negative-${kind}-loopback-only`,
      version: 'test', heartbeatIntervalMs: 100,
      assignmentIntervalMs: 20, capabilityProbeIntervalMs: 100,
      capabilities: [], labels: {}, warmModels: [],
      fakeGpus: [{
        uuid: `GPU-PHASE6A-NEGATIVE-${kind}`,
        index: 0, name: 'Synthetic Test GPU',
        memoryTotalMiB: 24_576, memoryUsedMiB: 0,
        utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
      }],
    }, {
      sessionAdapters: [adapter],
      discoverModelInventory: async () => [],
    });
    await agent.start();
    submitted = (await app.service.submitSession({
      projectId: `phase6a-negative-${kind}`,
      capability: CAPABILITY,
      requirements: {
        minVramMiB: 1_000,
        capabilities: [CAPABILITY],
        adapter: ADAPTER_ID,
      },
      recovery: { maxInterruptions: 0 },
    })).session;
    assert.equal(submitted.status, 'allocated');
    await waitUntil(async () => {
      const record = await app.database.getSession(submitted.id);
      return record.status === 'connecting' || record.status === 'active';
    }, 'negative E2E session connecting');
    const grant = await app.service.issueDataPlaneGrant(submitted.id, 'client');
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
      [DATA_PLANE_SUBPROTOCOL_V2, `gpulink.grant.${grant.token}`],
      { perMessageDeflate: false },
    );
    const events = monitor(socket);
    await openSocket(socket);
    assert.equal(socket.protocol, DATA_PLANE_SUBPROTOCOL_V2);
    await waitUntil(() => events.some((e) => e.type === DATA_PLANE_RELAY_READY_V2),
      'relay pairing for negative scenario');
    await waitUntil(() => events.some((e) => e.type === 'asr.model_ready.v1'),
      'synthetic runtime ready for negative scenario');
    assert.equal(started.length, 1);
    assert.equal((await app.database.getSession(submitted.id)).status, 'active');
    sendControl(socket, start);

    if (kind === 'client_cancel') {
      sendControl(socket, { type: 'asr.cancel.v1' });
      await waitUntil(() => events.some((e) => e.type === 'asr.cancelled.v1') ||
        events.some((e) => e.type === 'asr.error.v1' || e.type === '<socket-closed>'),
        'cancelled application response');
      assert.ok(events.some((e) => e.type === 'asr.cancelled.v1'),
        `Expected cancellation acknowledgment: ${JSON.stringify(events)}`);
    } else if (kind === 'client_disconnect') {
      socket.terminate();
      await waitUntil(() => events.some((e) => e.type === '<socket-closed>'),
        'client socket close');
    } else if (kind === 'lease_revoked') {
      await app.service.closeSession(submitted.id);
      await waitUntil(() => events.some((e) => e.type === '<socket-closed>'),
        'socket closure following authoritative lease/session revocation');
      assert.equal((await app.database.getSession(submitted.id)).status, 'closed');
    } else {
      assert.fail(`Unknown negative E2E scenario: ${kind}`);
    }

    const result = await limited(started[0].waitForExit(),
      `reaped synthetic Python process (${kind})`);
    assert.notEqual(result.state, 'completed',
      `Failure scenario ${kind} cannot report completed`);
    await waitUntil(() => events.some((e) => e.type === '<socket-closed>'),
      `terminal socket closure (${kind})`);
    assert.equal(events.some((e) => e.type === 'asr.completed.v1'), false,
      `Failure scenario ${kind} must never emit application success`);
  } finally {
    socket?.terminate();
    if (submitted?.id) {
      try { await app.service.closeSession(submitted.id); } catch { /* cleanup */ }
    }
    try { await agent?.stop(); } finally { await app.stop(); }
  }
}

for (const kind of ['client_cancel', 'client_disconnect', 'lease_revoked']) {
  test(`authenticated synthetic ASR: ${kind} cannot succeed and reaps Python`,
    { timeout: 20_000 }, () => runFailClosedScenario(kind));
}
