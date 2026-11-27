// Execute marked documentation examples against an independently installed SDK.
// Mock HTTP only. No GPU, real credentials, service startup or adapter approval.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const project=path.resolve(process.argv[2]??'');
assert.ok(process.argv[2] && !project.startsWith(root), 'Provide independent disposable project outside checkout');
function snippet(file,id,lang){
  const source=readFileSync(path.join(root,file),'utf8');
  const marker=`<!-- gpulink-example: ${id} -->\n\`\`\`${lang}\n`;
  const parts=source.split(marker);assert.equal(parts.length,2,`Missing/duplicate ${id}`);
  const end=parts[1].indexOf('\n```');assert.ok(end>0,`Incomplete ${id}`);return parts[1].slice(0,end);
}
const guide='docs/DEVELOPER_BATCH_QUICKSTART.md';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GPULINK_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)));
function run(bin,args,extraEnv={},success=true){
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{cwd:project,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe'],timeout:15000});
    let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);
    p.on('error',reject);p.on('close',(code,signal)=>{
      if(signal||((code===0)!==success)) reject(new Error(`Unexpected exit ${code}/${signal}: ${bin} ${args[0]}\n${stderr}`));else resolve(stdout);
    });
  });
}
for(const id of ['batch-init']) await run('bash',['-Eeuo','pipefail','-c',snippet(guide,id,'sh')]);
const starter=path.join(project,'author/workload.py');
const original=readFileSync(starter,'utf8');
const start=original.indexOf('def run(payload):\n'),end=original.indexOf('\ndef reject_constant',start);
assert.ok(start>=0&&end>start&&original.slice(start,end).includes('cpu-starter'));
writeFileSync(starter,original.slice(0,start)+snippet(guide,'batch-function','python')+'\n\n'+original.slice(end));
// Python compilation does not import torch or execute the adapter.
await run('python3',['-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',starter]);
for(const id of ['batch-pack','batch-inspect','batch-prepare']){
  const output=await run('bash',['-Eeuo','pipefail','-c',snippet(guide,id,'sh')],{PYTHON:process.env.PYTHON??'/usr/bin/python3'});console.log(output.trim());
}
const catalog=JSON.parse(readFileSync(path.join(project,'review/catalog.json'),'utf8'));
assert.equal(catalog.adapters[0].manifest.type,'external.batch.scale');
assert.equal(catalog.adapters[0].manifest.executionMode,'bounded-process');
console.log('PASS: exact documented authoring, packaging, inspection and catalog preparation commands (no approval)');
for(const [file,id,name] of [['README.md','readme-scale','scale.mjs'],[guide,'batch-submit','submit.mjs'],[guide,'batch-wait','wait.mjs']]){
  writeFileSync(path.join(project,name),snippet(file,id,'js')+'\n',{flag:'wx'});
}
const calls=[];let status='succeeded',result={values:[2,4,6],backend:'pytorch-cuda'};
const jobId='job-doc-example';
const server=createServer(async(req,res)=>{
  try{
    assert.equal(req.headers.authorization,'Bearer doc-example-test');
    calls.push([req.method,req.url,req.headers['idempotency-key']??null]);
    let job;
    if(req.method==='POST'){
      assert.equal(req.url,'/v1/jobs');let body='';for await(const part of req)body+=part;
      const input=JSON.parse(body);assert.equal(input.type,'external.batch.scale');assert.deepEqual(input.payload,{values:[1,2,3]});assert.equal(input.maxAttempts,1);assert.equal(input.constraints.gpuCount,1);
      job={id:jobId,status:'queued'};
    }else{
      assert.equal(req.method,'GET');assert.equal(req.url,`/v1/jobs/${jobId}`);job={id:jobId,status,result};
    }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({job,duplicate:false}));
  }catch(e){res.writeHead(500).end('mock contract assertion failed');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try{
  const local={GPULINK_BASE_URL:`http://127.0.0.1:${server.address().port}`,GPULINK_CLIENT_TOKEN:'doc-example-test'};
  assert.match(await run(process.execPath,['scale.mjs','readme-request'],local),/pytorch-cuda/);
  assert.equal((await run(process.execPath,['submit.mjs','batch-request'],local)).trim(),jobId);
  assert.match(await run(process.execPath,['wait.mjs',jobId],local),/pytorch-cuda/);
  assert.deepEqual(calls,[['POST','/v1/jobs','readme-request'],['GET',`/v1/jobs/${jobId}`,null],['POST','/v1/jobs','batch-request'],['GET',`/v1/jobs/${jobId}`,null]]);
  status='failed';await run(process.execPath,['wait.mjs',jobId],local,false);
  status='succeeded';result={values:[2,4,6],backend:'cpu-starter'};await run(process.execPath,['wait.mjs',jobId],local,false);
  await run(process.execPath,['scale.mjs','bad-backend-request'],local,false);
  const before=calls.length;await run(process.execPath,['submit.mjs'],local,false);assert.equal(calls.length,before);
  console.log('PASS: extracted README and batch client examples, error handling, no resubmission on wait (mock HTTP only)');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
