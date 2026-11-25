/** Example application uses *only* the public installed Client SDK. */
import assert from 'node:assert/strict';
import {GPULinkClient} from '@gpulink/client';

const CAPABILITY = 'example.cuda.matrix';
const ADAPTER = 'example.cuda.matrix.v1';
const PREPARE = '{"type":"example.matrix.prepare.v1"}';
const MODEL_READY = '{"type":"example.matrix.ready.v1","backend":"pytorch-cuda"}';
const COMPLETED = '{"type":"gpulink.session.completed.v1"}';
const client = new GPULinkClient({
  baseUrl:process.env.GPULINK_BASE_URL, token:process.env.GPULINK_CLIENT_TOKEN,
});
let session;
try {
  session = await client.openSession({
    projectId:'external-matrix-preview', capability:CAPABILITY,
    requirements:{capabilities:[CAPABILITY],adapter:ADAPTER,minVramMiB:1000},
    recovery:{maxInterruptions:0},
  }, {allocationTimeoutMs:20_000,connectTimeoutMs:8_000});

  const pending = [];
  const received = [];
  const stop = session.onMessage(message => {
    const next = pending.shift();
    if (next) next(message);
    else received.push(message);
  });
  function nextMessage(name, deadline=20_000) {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)),deadline);
      const callback = message => {clearTimeout(timer);resolve(message);};
      if (received.length) callback(received.shift());
      else pending.push(callback);
    });
  }

  const ready = nextMessage('workload model readiness');
  session.sendText(PREPARE);
  assert.equal(await ready, MODEL_READY);

  const buffer = new ArrayBuffer(16);
  const floats = new DataView(buffer);
  for (const [i,v] of [1,2,3,4].entries()) floats.setFloat32(i*4,v,false);
  const prediction = nextMessage('matrix output');
  const execution = nextMessage('GPU execution acknowledgment');
  session.sendBinary(new Uint8Array(buffer));
  const [result, executionMessage] = await Promise.all([prediction, execution]);
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.byteLength,16);
  const view = new DataView(result.buffer,result.byteOffset,result.byteLength);
  const values = Array.from({length:4},(_,i)=>view.getFloat32(i*4,false));
  assert.deepEqual(values,[11,16,11,14]);
  const metadata = JSON.parse(executionMessage);
  assert.equal(metadata.type,'example.matrix.executed.v1');
  assert.ok(Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs >= 0);

  const completion = nextMessage('completion');
  session.sendText('{"type":"gpulink.session.end.v1"}');
  assert.equal(await completion,COMPLETED);
  stop();
  await session.close();
  const closed = (await client.getSession(session.id)).session;
  assert.equal(closed.status,'closed');
  assert.equal(closed.assignedWorkerId,null);
  assert.equal(closed.assignedGpuUuid,null);
  console.log(JSON.stringify({event:'matrix_cuda_pass',values,
    executionMs:metadata.elapsedMs}));
} finally {
  if (session?.isOpen) await session.close();
}
