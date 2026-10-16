/** External client fixture: public @gpulink/client only; no GPULink Core imports. */
import assert from 'node:assert/strict';
import { GPULinkClient } from '@gpulink/client';

const client = new GPULinkClient({
  baseUrl: process.env.GPULINK_BASE_URL,
  token: process.env.GPULINK_CLIENT_TOKEN,
});
const CAPABILITY = 'example.subprocess.echo';
const ADAPTER_ID = 'example.subprocess.echo.v1';
const END = '{"type":"gpulink.session.end.v1"}';
const COMPLETED = '{"type":"gpulink.session.completed.v1"}';
let session;
try {
  session = await client.openSession({
    projectId: 'external-sdk-and-approved-adapter',
    capability: CAPABILITY,
    requirements: {
      capabilities: [CAPABILITY], adapter: ADAPTER_ID, minVramMiB: 1_000,
    },
    recovery: {maxInterruptions: 0},
  }, {allocationTimeoutMs: 8_000, connectTimeoutMs: 5_000});

  // Subscribe before sending; preserve event ordering without parsing the GLIP
  // adapter IPC. The public client sees only application-level relay frames.
  const messages = [];
  const pending = [];
  const stop = session.onMessage(message => {
    const next = pending.shift();
    if (next) next(message);
    else messages.push(message);
  });
  function nextMessage(label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3_000);
      const deliver = message => { clearTimeout(timer); resolve(message); };
      if (messages.length) deliver(messages.shift());
      else pending.push(deliver);
    });
  }
  const payload = Uint8Array.from([0, 255, 7, 42]);
  const binaryResponse = nextMessage('binary echo');
  session.sendBinary(payload);
  const echoed = await binaryResponse;
  assert.ok(echoed instanceof Uint8Array, 'expected a binary relay frame');
  assert.deepEqual(Buffer.from(echoed), Buffer.from(payload));

  const completion = nextMessage('explicit completion');
  session.sendText(END);
  assert.equal(await completion, COMPLETED);
  stop();
  await session.close();
  assert.equal((await client.getSession(session.id)).session.status, 'closed');
  console.log(JSON.stringify({event:'approved_adapter_client_complete'}));
} finally {
  if (session && session.isOpen) await session.close();
}
