import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rank,verify} from './reference.mjs';
const fixture=JSON.parse(readFileSync(new URL('./sample.json',import.meta.url)));
test('independent reference ranks sample',()=>assert.deepEqual(rank(fixture),[{id:'audio',score:95},{id:'video',score:93},{id:'render',score:88}]));
test('ties deterministic',()=>assert.deepEqual(rank({query:[1],items:[{id:'b',vector:[2]},{id:'a',vector:[2]}],topK:2}),[{id:'a',score:2},{id:'b',score:2}]));
test('invalid inputs refused',()=>{for(const p of [{...fixture,topK:0},{...fixture,query:[1]},{...fixture,items:[fixture.items[0],fixture.items[0]]},{...fixture,query:[1,2,3,101]}]) assert.throws(()=>rank(p));});
test('result assertion rejects CPU and incorrect ranks',()=>{const job={status:'succeeded',attempt:1,leaseExpiresAt:null,assignedGpuUuid:'GPU-326a4232-3d30-423b-29a1-66f2d054a0d4',assignedWorkerId:'test',result:{backend:'pytorch-cuda',metric:'inner-product',ranked:rank(fixture)}};verify(job,fixture);assert.throws(()=>verify({...job,result:{...job.result,backend:'cpu'}},fixture));assert.throws(()=>verify({...job,result:{...job.result,ranked:[]}},fixture));});

test('independent submit and wait processes use installed SDK against mock HTTP only', async()=>{
  const {createServer}=await import('node:http');
  const {spawn}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const cwd=fileURLToPath(new URL('.',import.meta.url));
  const calls=[];
  const id='job-vector-mock';
  const mock={id,status:'succeeded',attempt:1,leaseExpiresAt:null,assignedGpuUuid:'GPU-326a4232-3d30-423b-29a1-66f2d054a0d4',assignedWorkerId:'mock-worker',result:{backend:'pytorch-cuda',metric:'inner-product',ranked:rank(fixture)}};
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const part of req) body+=part;
      calls.push([req.method,req.url,req.headers['idempotency-key']]);
      assert.equal(req.headers.authorization,'Bearer mock-token');
      if(req.method==='POST') {
        const input=JSON.parse(body);assert.equal(input.type,'external.batch.vector-search');assert.deepEqual(input.payload,fixture);assert.equal(input.maxAttempts,1);
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({job:{id,status:'queued'},duplicate:false}));
      } else res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({job:mock}));
    } catch(e) {res.writeHead(500).end('mock assertion failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={...process.env,GPULINK_BASE_URL:`http://127.0.0.1:${server.address().port}`,GPULINK_CLIENT_TOKEN:'mock-token'};
  const execute=(...args)=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['search.mjs',...args],{cwd,env,stdio:['ignore','pipe','pipe'],timeout:5000});let stdout='',stderr='';
    p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr||`exit ${code}`)));
  });
  try {
    const submitted=JSON.parse(await execute('submit','sample.json','mock-idempotency'));
    assert.equal(submitted.jobId,id);
    const observed=await execute('wait',id,'sample.json');
    assert.match(observed,/PASS: remote CUDA ranking/); // Mock result only; physical execution is a separate gate.
    assert.deepEqual(calls,[['POST','/v1/jobs','mock-idempotency'],['GET',`/v1/jobs/${id}`,undefined]]);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
