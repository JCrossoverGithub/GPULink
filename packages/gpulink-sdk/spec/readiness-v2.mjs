import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebSocket as WorkerWebSocket, WebSocketServer } from 'ws';
import { createControlPlane } from '../../../src/control-plane/app.mjs';
import { createDataPlaneProtocols } from '../../../src/shared/data-plane-contract.mjs';
import { GPULinkClient, GPULINK_DATA_PLANE_PROTOCOL, GPULINK_DATA_PLANE_PROTOCOL_V2, GPULINK_RELAY_READY_V2 } from '../dist/index.js';

const tokens = {
  client: 'phase5e-ready-client-token-at-least-32-characters',
  worker: 'phase5e-ready-worker-token-at-least-32-characters',
  admin: 'phase5e-ready-admin-token-at-least-32-characters',
};
const config = () => ({
  host: '127.0.0.1', port: 0, dataPath: ':memory:', tokens,
  dataPlaneSigningKey: 'phase5e-ready-signing-key-at-least-32-characters',
  dataPlaneGrantTtlMs: 15_000, heartbeatTimeoutMs: 60_000,
  leaseDurationMs: 30_000, schedulerIntervalMs: 60_000, vramSafetyMiB: 512,
});
const workerRequest = () => ({
  name: 'phase5e-ready-worker', version: 'test', labels: {},
  capabilities: ['speech.streaming'], warmModels: [], modelInventory: [],
  gpus: [{
    uuid: 'GPU-PHASE5E-READY', index: 0, name: 'Test GPU',
    memoryTotalMiB: 24_576, memoryUsedMiB: 0,
    utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
  }],
});
const sessionRequest = () => ({
  projectId: 'phase5e-ready', capability: 'speech.streaming',
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
  const grant = await app.service.issueDataPlaneGrant(
    connecting.id, 'worker', { workerId: worker.id, leaseId: connecting.leaseId },
  );
  return { client, connecting, workerGrant: grant };
}
function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WorkerWebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('worker open timeout')), 4000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
function nextWorkerMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker frame timeout')), 2000);
    socket.once('message', (data, isBinary) => { clearTimeout(timer); resolve({ data, isBinary }); });
    socket.once('error', reject);
  });
}

// Real relay: a v2 client must wait until a v1 worker pairs and the server ACK arrives.
test('SDK v2 receives explicit server ready ACK when paired with an unchanged v1 worker', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  let workerSocket;
  let stream;
  try {
    const { client, connecting, workerGrant } = await prepare(app, `http://127.0.0.1:${address.port}`);
    let resolved = false;
    const pending = client.connectSession(connecting.id, { protocolVersion: 2, connectTimeoutMs: 3000 }).then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.equal(resolved, false, 'must not resolve before pairing');
    workerSocket = new WorkerWebSocket(
      `ws://127.0.0.1:${address.port}/v1/data-plane`,
      createDataPlaneProtocols(workerGrant.token),
    );
    await waitOpen(workerSocket);
    stream = await pending;
    assert.equal(workerSocket.protocol, GPULINK_DATA_PLANE_PROTOCOL);
    assert.equal(stream.protocol, GPULINK_DATA_PLANE_PROTOCOL_V2);
    assert.equal(stream.isOpen, true);
    assert.equal((await client.getSession(connecting.id)).session.status, 'active');
    const frames = [];
    const unsubscribe = stream.onMessage((frame) => frames.push(frame));
    const received = nextWorkerMessage(workerSocket);
    stream.sendBinary(Uint8Array.from([0, 100, 255]));
    assert.deepEqual((await received).data, Buffer.from([0, 100, 255]));
    assert.throws(() => stream.sendText(GPULINK_RELAY_READY_V2), /reserved relay control/);
    workerSocket.send('worker-response');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(frames, ['worker-response'], 'readiness frame must not reach app');
    unsubscribe();
  } finally {
    stream?.close();
    workerSocket?.terminate();
    await app.stop();
  }
});

test('SDK v2 fails closed on peer wait deadline; no v1 fallback', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  try {
    const { client, connecting } = await prepare(app, `http://127.0.0.1:${address.port}`);
    await assert.rejects(
      client.connectSession(connecting.id, { protocolVersion: 2, connectTimeoutMs: 220 }),
      /deadline exceeded|timed out|relay readiness/,
    );
    assert.equal((await client.getSession(connecting.id)).session.status, 'connecting');
    await assert.rejects(client.connectSession(connecting.id, { protocolVersion: 3 }), /protocolVersion/);
  } finally {
    await app.stop();
  }
});

test('SDK v2 caller abort interrupts the readiness wait against real relay', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  try {
    const { client, connecting } = await prepare(app, `http://127.0.0.1:${address.port}`);
    const ctrl = new AbortController();
    const attempt = client.connectSession(connecting.id, { protocolVersion: 2, signal: ctrl.signal, connectTimeoutMs: 3000 });
    setTimeout(() => ctrl.abort(new Error('caller stopped waiting')), 110);
    await assert.rejects(attempt, /caller stopped waiting/);
    assert.equal((await client.getSession(connecting.id)).session.status, 'connecting');
  } finally {
    await app.stop();
  }
});

async function fakeRelay(mode, callback) {
  const http = createServer((req, res) => {
    if (req.url?.endsWith('/client-grant')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ grant: {
        token: 'gdp1.synthetic.signature', expiresAt: Date.now() + 5_000,
      } }));
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols(protocols) {
    return protocols.has(GPULINK_DATA_PLANE_PROTOCOL_V2) ? GPULINK_DATA_PLANE_PROTOCOL_V2 : false;
  } });
  http.on('upgrade', (req, socket, head) => {
    if (mode === 'wrong-version') {
      // A v1-only relay rejects the unrecognized v2 upgrade; no client downgrade.
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws) => {
    if (mode === 'bad-ack') ws.send('not-relay-ready');
    if (mode === 'correct-ack') ws.send(GPULINK_RELAY_READY_V2);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = http.address();
    return await callback(new GPULinkClient({ baseUrl: `http://127.0.0.1:${port}`, token: tokens.client }));
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
}

test('SDK v2 never accepts a v1-only server response', async () => {
  await fakeRelay('wrong-version', async (client) => {
    await assert.rejects(client.connectSession('session', { protocolVersion: 2, connectTimeoutMs: 1000 }), /handshake|subprotocol|readiness|closed/);
  });
});

test('SDK v2 rejects missing/invalid readiness instead of completing connection', async () => {
  await fakeRelay('bad-ack', async (client) => {
    await assert.rejects(client.connectSession('session', { protocolVersion: 2, connectTimeoutMs: 190 }), /deadline exceeded|timed out|readiness/);
  });
});
