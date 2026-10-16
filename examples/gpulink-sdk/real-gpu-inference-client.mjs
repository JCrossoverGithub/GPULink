/** Example application uses *only* the public installed Client SDK. */
import assert from 'node:assert/strict';
import {GPULinkClient} from '@gpulink/client';

const CAPABILITY = 'example.cuda.inference';
const ADAPTER = 'example.cuda.inference.v1';
const PREPARE = '{"type":"example.gpu.prepare.v1"}';
const MODEL_READY = '{"type":"example.gpu.model.ready.v1","backend":"pytorch-cuda"}';
const COMPLETED = '{"type":"gpulink.session.completed.v1"}';
const client = new GPULinkClient({
  baseUrl:process.env.GPULINK_BASE_URL, token:process.env.GPULINK_CLIENT_TOKEN,
});
let session;
try {
  session = await client.openSession({
    projectId:'external-real-gpu-acceptance', capability:CAPABILITY,
    requirements:{capabilities:[CAPABILITY],adapter:ADAPTER,minVramMiB:1000},
    recovery:{maxInterruptions:0},
  }, {allocationTimeoutMs:10_000,connectTimeoutMs:8_000});

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
  const prediction = nextMessage('neural network output');
  const execution = nextMessage('GPU execution acknowledgment');
  session.sendBinary(new Uint8Array(buffer));
  const result = await prediction;
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.byteLength,4);
  const value = new DataView(result.buffer,result.byteOffset,result.byteLength).getFloat32(0,false);
  assert.ok(Math.abs(value-15.5) <= 1e-5, `incorrect GPU output: ${value}`);
  const metadata = JSON.parse(await execution);
  assert.equal(metadata.type,'example.gpu.executed.v1');
  assert.ok(Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs >= 0);

  const completion = nextMessage('completion');
  session.sendText('{"type":"gpulink.session.end.v1"}');
  assert.equal(await completion,COMPLETED);
  stop();
  await session.close();
  assert.equal((await client.getSession(session.id)).session.status,'closed');
  console.log(JSON.stringify({event:'real_gpu_adapter_pass',prediction:value,
    executionMs:metadata.elapsedMs}));
} finally {
  if (session?.isOpen) await session.close();
}
