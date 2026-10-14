// Standalone application: no control-plane, scheduler, or worker-module imports.
import assert from 'node:assert/strict';
import { GPULinkClient, GPULINK_DATA_PLANE_PROTOCOL_V2 } from '@gpulink/client';

const client = new GPULinkClient({
  baseUrl: process.env.GPULINK_BASE_URL,
  token: process.env.GPULINK_CLIENT_TOKEN,
});

const { session } = await client.requestSession({
  projectId: 'phase5e-external-example',
  capability: 'speech.streaming',
  requirements: {
    gpuCount: 1,
    minVramMiB: 1_000,
    capabilities: ['speech.streaming'],
  },
  recovery: { maxInterruptions: 1 },
});
let stream;
let sessionClosed = false;
try {
  assert.equal(session.status, 'allocated');

  // Test harness coordinates its synthetic worker before the client grant request.
  // In a deployed application, a worker agent independently starts the session.
  if (process.env.GPULINK_EXAMPLE_HARNESS === '1') {
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('example worker setup timed out')), 5_000);
      process.stdin.once('data', (data) => {
        clearTimeout(timeout);
        if (String(data).trim() === 'WORKER_STARTED') resolve();
        else reject(new Error('unexpected example harness response'));
      });
    });
    console.log(JSON.stringify({ event: 'session_allocated', sessionId: session.id }));
    await ready;
  }

  stream = await client.connectSession(session.id, {
    protocolVersion: 2,
    connectTimeoutMs: 6_000,
  });
  assert.equal(stream.protocol, GPULINK_DATA_PLANE_PROTOCOL_V2);

  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('example worker response timed out')), 3_000);
    const stopMessages = stream.onMessage((message) => {
      clearTimeout(timer);
      stopMessages();
      resolve(message);
    });
    stream.onClose((event) => {
      clearTimeout(timer);
      reject(new Error(`stream closed before reply: ${event.code}`));
    });
  });

  stream.sendBinary(Uint8Array.from([21, 22, 23]));
  assert.equal(await response, 'example-worker-response');
  const closed = await client.closeSession(session.id);
  sessionClosed = closed.session.status === 'closed';
  assert.equal(sessionClosed, true);
  console.log(JSON.stringify({ event: 'stream_complete', sessionId: session.id }));
} finally {
  stream?.close();
  if (!sessionClosed) {
    // Release the authoritative session even when setup or streaming fails.
    await client.closeSession(session.id);
  }
}
