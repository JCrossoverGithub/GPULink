import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlane } from '../../../src/control-plane/app.mjs';
import { GPULinkApiError, GPULinkClient } from '../dist/index.js';

const tokens = {
  client: 'phase5e-client-token-at-least-32-characters',
  worker: 'phase5e-worker-token-at-least-32-characters',
  admin: 'phase5e-admin-token-at-least-32-characters',
};
function config() {
  return {
    host: '127.0.0.1', port: 0, dataPath: ':memory:', tokens,
    heartbeatTimeoutMs: 60_000, leaseDurationMs: 10_000,
    schedulerIntervalMs: 60_000, vramSafetyMiB: 512,
  };
}
test('TypeScript SDK uses public finite-job routes and idempotency', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  try {
    const client = new GPULinkClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: tokens.client,
    });
    const request = {
      projectId: 'phase5e-sdk', type: 'diagnostic.gpu-status', priority: 100,
      constraints: { gpuCount: 1, minVramMiB: 256, capabilities: ['diagnostic.gpu-status'] },
      payload: {}, maxAttempts: 2,
    };
    const created = await client.submitJob(request, { idempotencyKey: 'phase5e-job-1' });
    assert.equal(created.duplicate, false);
    assert.equal(typeof created.job.id, 'string');
    const duplicate = await client.submitJob(request, { idempotencyKey: 'phase5e-job-1' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, created.job.id);
    const fetched = await client.getJob(created.job.id);
    assert.equal(fetched.job.id, created.job.id);
    const listed = await client.listJobs({ limit: 10 });
    assert.ok(listed.jobs.some((job) => job.id === created.job.id));
    const cancelled = await client.cancelJob(created.job.id);
    assert.equal(cancelled.job.status, 'cancelled');
  } finally {
    await app.stop();
  }
});
test('TypeScript SDK uses client-scoped session routes and fails closed', async () => {
  const app = createControlPlane(config());
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const client = new GPULinkClient({ baseUrl, token: tokens.client });
    const created = await client.requestSession({
      projectId: 'phase5e-sdk', capability: 'speech.streaming',
      requirements: { gpuCount: 1, minVramMiB: 1_000, capabilities: ['speech.streaming'] },
      recovery: { maxInterruptions: 1 },
    }, { idempotencyKey: 'phase5e-session-1' });
    assert.equal(created.duplicate, false);
    assert.equal(created.session.status, 'requested');
    const fetched = await client.getSession(created.session.id);
    assert.equal(fetched.session.id, created.session.id);
    const listed = await client.listSessions({ status: 'requested', limit: 10 });
    assert.ok(listed.sessions.some((session) => session.id === created.session.id));
    await assert.rejects(client.requestClientGrant(created.session.id),
      (error) => error instanceof GPULinkApiError && error.status === 409);
    const invalidClient = new GPULinkClient({ baseUrl, token: 'invalid-client-token' });
    await assert.rejects(invalidClient.getSession(created.session.id),
      (error) => error instanceof GPULinkApiError && error.status === 401);
    const closed = await client.closeSession(created.session.id);
    assert.equal(closed.session.status, 'closed');
  } finally {
    await app.stop();
  }
});
test('SDK refuses insecure remote endpoints and invalid request options', async () => {
  assert.throws(() => new GPULinkClient({ baseUrl: 'http://example.com', token: tokens.client }), /HTTPS/);
  assert.throws(() => new GPULinkClient({ baseUrl: 'https://example.com/other', token: tokens.client }), /origin/);
  assert.throws(() => new GPULinkClient({ baseUrl: 'https://example.com', token: 'invalid\r\ntoken' }), /token/);
  const client = new GPULinkClient({ baseUrl: 'https://example.com', token: tokens.client });
  await assert.rejects(client.listJobs({ limit: 999 }), /limit/);
  await assert.rejects(client.getJob(''), /id/);
});
