import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { GPULinkClient } from '../dist/index.js';

async function withSlowServer(callback) {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/client-grant')) {
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ grant: { token: 'gdp1.placeholder.signature', expiresAt: Date.now() + 5000 } }));
        }
      }, 500);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await callback(new GPULinkClient({baseUrl:`http://127.0.0.1:${port}`, token:'nonsecret-test-token', timeoutMs:10_000}));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('preaborted connect fails before issuing a grant', async () => {
  await withSlowServer(async (client) => {
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));
    await assert.rejects(client.connectSession('sample', { signal: controller.signal }), /client cancelled/);
    await assert.rejects(client.connectSession('sample', { signal: {} }), /AbortSignal/);
  });
});

test('connect end-to-end deadline applies to stalled grant acquisition', async () => {
  await withSlowServer(async (client) => {
    const begin = Date.now();
    await assert.rejects(client.connectSession('sample', { connectTimeoutMs: 140 }), /deadline exceeded/);
    assert.ok(Date.now() - begin < 1100, 'connection deadline must not wait for HTTP timeout');
  });
});

test('external cancellation interrupts a stalled grant request promptly', async () => {
  await withSlowServer(async (client) => {
    const controller = new AbortController();
    const begin = Date.now();
    const attempt = client.connectSession('sample', { signal: controller.signal, connectTimeoutMs: 4000 });
    setTimeout(() => controller.abort(new Error('stop stream')), 80);
    await assert.rejects(attempt, /stop stream/);
    assert.ok(Date.now() - begin < 1100, 'caller abort should not wait for HTTP timeout');
  });
});
