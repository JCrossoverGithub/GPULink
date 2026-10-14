import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket as WorkerWebSocket } from 'ws';
import { createControlPlane } from '../../../src/control-plane/app.mjs';
import { createDataPlaneProtocols } from '../../../src/shared/data-plane-contract.mjs';
import { GPULinkClient, GPULINK_DATA_PLANE_PROTOCOL, GPULINK_MAX_FRAME_BYTES } from '../dist/index.js';

const tokens = {
  client: 'phase5e-stream-client-token-at-least-32-characters',
  worker: 'phase5e-stream-worker-token-at-least-32-characters',
  admin: 'phase5e-stream-admin-token-at-least-32-characters',
};
const config = () => ({
  host: '127.0.0.1', port: 0, dataPath: ':memory:', tokens,
  dataPlaneSigningKey: 'phase5e-stream-signing-key-at-least-32-characters',
  dataPlaneGrantTtlMs: 15_000,
  heartbeatTimeoutMs: 60_000, leaseDurationMs: 30_000,
  schedulerIntervalMs: 60_000, vramSafetyMiB: 512,
});
const workerRequest = () => ({
  name: 'phase5e-stream-worker', version: 'test', labels: {},
  capabilities: ['speech.streaming'], warmModels: [], modelInventory: [],
  gpus: [{
    uuid: 'GPU-PHASE5E-STREAM', index: 0, name: 'Test GPU',
    memoryTotalMiB: 24_576, memoryUsedMiB: 0,
    utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
  }],
});
const sessionRequest = () => ({
  projectId: 'phase5e-stream', capability: 'speech.streaming',
  requirements: { minVramMiB: 1_000, capabilities: ['speech.streaming'] },
  recovery: { maxInterruptions: 1 },
});

async function prepare(app, baseUrl) {
  const worker = await app.service.registerWorker(workerRequest());
  const client = new GPULinkClient({ baseUrl, token: tokens.client });
  const { session: allocated } = await client.requestSession(sessionRequest());
  assert.equal(allocated.status, 'allocated');
  const connecting = await app.service.startSession(allocated.id, {
    workerId: worker.id, leaseId: allocated.leaseId,
  });
  assert.equal(connecting.status, 'connecting');
  const workerGrant = await app.service.issueDataPlaneGrant(
    connecting.id, 'worker', { workerId: worker.id, leaseId: connecting.leaseId },
  );
  return { client, connecting, workerGrant };
}

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WorkerWebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('worker WS open timeout')), 4000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
function nextWorkerMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker message timeout')), 2000);
    socket.once('message', (data, isBinary) => { clearTimeout(timer); resolve({ data, isBinary }); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
function nextClientMessage(stream) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client message timeout')), 2000);
    const off = stream.onMessage((message) => { clearTimeout(timer); off(); resolve(message); });
  });
}
function nextClose(stream) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream close timeout')), 3000);
    const off = stream.onClose((event) => { clearTimeout(timer); off(); resolve(event); });
  });
}

test('SDK authenticates, waits for pairing, exchanges binary/text and invalidates closed leases', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let workerSocket;
  let stream;
  try {
    const { client, connecting, workerGrant } = await prepare(app, baseUrl);
    const pending = client.connectSession(connecting.id, { connectTimeoutMs: 5000 });
    workerSocket = new WorkerWebSocket(
      `ws://127.0.0.1:${address.port}/v1/data-plane`,
      createDataPlaneProtocols(workerGrant.token),
    );
    await waitOpen(workerSocket);
    stream = await pending;
    assert.equal(workerSocket.protocol, GPULINK_DATA_PLANE_PROTOCOL);
    assert.equal(stream.isOpen, true);
    assert.equal((await client.getSession(connecting.id)).session.status, 'active');

    const binaryReceived = nextWorkerMessage(workerSocket);
    const binary = Uint8Array.from([0, 127, 128, 255]);
    stream.sendBinary(binary);
    const fromClient = await binaryReceived;
    assert.equal(fromClient.isBinary, true);
    assert.deepEqual(fromClient.data, Buffer.from(binary));

    const textReceived = nextClientMessage(stream);
    workerSocket.send('adapter-response');
    assert.equal(await textReceived, 'adapter-response');

    assert.throws(() => stream.sendBinary(new Uint8Array(GPULINK_MAX_FRAME_BYTES + 1)), /1 MiB/);
    assert.throws(() => stream.sendText('z'.repeat(GPULINK_MAX_FRAME_BYTES + 1)), /1 MiB/);
    assert.throws(() => stream.sendBinary('not-binary'), /binary/);

    const closing = nextClose(stream);
    await client.closeSession(connecting.id);
    const closeInfo = await closing;
    assert.equal(closeInfo.code, 4410);
    assert.equal(stream.isOpen, false);
    assert.throws(() => stream.sendText('after-close'), /not open/);

    const stored = await app.database.getSession(connecting.id);
    assert.equal(JSON.stringify(stored).includes('adapter-response'), false);
    const events = await app.database.listEventsAfter(0);
    assert.equal(JSON.stringify(events).includes('adapter-response'), false);
  } finally {
    stream?.close();
    workerSocket?.terminate();
    await app.stop();
  }
});

test('SDK times out safely if a grant is accepted but no worker pairs', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  try {
    const { client, connecting } = await prepare(app, `http://127.0.0.1:${address.port}`);
    await assert.rejects(
      client.connectSession(connecting.id, { connectTimeoutMs: 300 }),
      /timed out|closed before session became active/,
    );
    const { session } = await client.getSession(connecting.id);
    assert.equal(session.status, 'connecting');
  } finally {
    await app.stop();
  }
});

test('SDK rejects client-grant request for an unallocated session and rejects timeout options', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  try {
    const client = new GPULinkClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: tokens.client,
    });
    const { session } = await client.requestSession(sessionRequest());
    assert.equal(session.status, 'requested');
    await assert.rejects(client.connectSession(session.id), (error) => error.status === 409);
    await assert.rejects(client.connectSession(session.id, { connectTimeoutMs: 10 }), /connectTimeoutMs/);
  } finally {
    await app.stop();
  }
});
