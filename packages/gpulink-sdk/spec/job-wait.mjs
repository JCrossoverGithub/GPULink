import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { GPULinkClient, GPULinkApiError, GPULinkJobWaitTimeoutError } from '../dist/index.js';

const id = 'job-test';
async function fixture(handler, run) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push([req.method, req.url, req.headers.authorization]);
    handler(req, res, calls.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = GPULinkClient.fromEnv({GPULINK_BASE_URL:`http://127.0.0.1:${server.address().port}`,GPULINK_CLIENT_TOKEN:'test-token'});
  try { await run(client, calls); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
function json(res, body, status=200) {
  res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify(body));
}
test('explicit environment configuration preserves existing endpoint and credential validation', () => {
  assert.throws(() => GPULinkClient.fromEnv({}), /GPULINK_BASE_URL/);
  assert.throws(() => GPULinkClient.fromEnv({GPULINK_BASE_URL:'https://example.com',GPULINK_ADMIN_TOKEN:'not-a-client-token'}), /GPULINK_CLIENT_TOKEN/);
  assert.throws(() => GPULinkClient.fromEnv({GPULINK_BASE_URL:'http://example.com',GPULINK_CLIENT_TOKEN:'token'}), /HTTPS/);
  assert.throws(() => GPULinkClient.fromEnv({GPULINK_BASE_URL:'https://example.com',GPULINK_CLIENT_TOKEN:'bad token'}), /token/);
});
test('wait observes queued, leased, running and returns the complete terminal record', async () => {
  const states = ['queued','leased','running','succeeded'];
  await fixture((req,res,n) => json(res,{job:{id,status:states[n-1],result:n===4?{values:[2,4,6]}:null}}), async (client,calls) => {
    const record = await client.waitForJob(id,{pollIntervalMs:100,timeoutMs:3000});
    assert.deepEqual(record,{id,status:'succeeded',result:{values:[2,4,6]}});
    assert.deepEqual(calls,Array(4).fill(['GET','/v1/jobs/job-test','Bearer test-token']));
  });
});
for (const status of ['failed','cancelled']) {
  test(`wait returns terminal ${status} without resubmission or cancellation`, async () => {
    await fixture((req,res)=>json(res,{job:{id,status,result:null}}),async(client,calls)=>{
      assert.equal((await client.waitForJob(id)).status,status);
      assert.equal(calls.length,1);
      assert.equal(calls[0][0],'GET');
    });
  });
}
for (const job of [null,{id:'wrong',status:'succeeded'},{id,status:'unexpected'}]) {
  test(`wait rejects invalid record ${JSON.stringify(job)}`,async()=>{
    await fixture((req,res)=>json(res,{job}),async(client,calls)=>{
      await assert.rejects(client.waitForJob(id),/invalid job record|unknown job status/);
      assert.equal(calls.length,1);
    });
  });
}
test('HTTP errors propagate without retries',async()=>{
  await fixture((req,res)=>json(res,{error:{code:'unauthorized',message:'unauthorized'}},401),async(client,calls)=>{
    await assert.rejects(client.waitForJob(id),e=>e instanceof GPULinkApiError && e.status===401);
    assert.equal(calls.length,1);
  });
});
test('deadline includes a stalled HTTP response',async()=>{
  await fixture(()=>{},async(client,calls)=>{
    await assert.rejects(client.waitForJob(id,{timeoutMs:200}),e=>e instanceof GPULinkJobWaitTimeoutError && e.jobId===id);
    assert.ok(calls.length<=1);
  });
});
test('deadline interrupts polling delay without mutating job',async()=>{
  await fixture((req,res)=>json(res,{job:{id,status:'queued'}}),async(client,calls)=>{
    await assert.rejects(client.waitForJob(id,{timeoutMs:400,pollIntervalMs:30000}),{code:'JOB_WAIT_TIMEOUT'});
    assert.equal(calls.length,1);
  });
});
test('caller abort interrupts an outstanding read',async()=>{
  const controller=new AbortController();
  await fixture(()=>controller.abort(new Error('stop observing')),async(client,calls)=>{
    await assert.rejects(client.waitForJob(id,{signal:controller.signal}),/stop observing/);
    assert.equal(calls.length,1);
  });
});
test('pre-abort and invalid wait options make no requests',async()=>{
  await fixture((req,res)=>json(res,{}),async(client,calls)=>{
    await assert.rejects(client.waitForJob(id,{signal:AbortSignal.abort(new Error('stop'))}),/stop/);
    for(const options of [{timeoutMs:0},{timeoutMs:3600001},{pollIntervalMs:1},{signal:{}}]) await assert.rejects(client.waitForJob(id,options));
    assert.equal(calls.length,0);
  });
});
