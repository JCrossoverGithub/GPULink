import {readFile} from 'node:fs/promises';
import {GPULinkClient} from '@gpulink/client';
import {rank,verify} from './reference.mjs';
const [action,a,b,...extra]=process.argv.slice(2);
try {
  if (extra.length || !['submit','wait','get','cancel','expected'].includes(action) || !a || (['submit','wait'].includes(action) ? !b : b!==undefined)) throw new Error('Usage: node search.mjs submit INPUT.json KEY | wait JOB_ID INPUT.json | get JOB_ID | cancel JOB_ID | expected INPUT.json');
  if (action==='expected') console.log(JSON.stringify(rank(JSON.parse(await readFile(a,'utf8')))));
  else {
    const client=GPULinkClient.fromEnv(process.env);
    if (action==='submit') {
      const payload=JSON.parse(await readFile(a,'utf8'));
      rank(payload);
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(b)) throw new Error('invalid idempotency key');
      const {job,duplicate}=await client.submitJob({projectId:'dev06-vector-search',type:'external.batch.vector-search',constraints:{gpuCount:1,minVramMiB:1000},payload,maxAttempts:1},{idempotencyKey:b});
      console.log(JSON.stringify({event:'submitted',jobId:job.id,status:job.status,duplicate}));
    } else if (action==='wait') {
      const payload=JSON.parse(await readFile(b,'utf8'));
      rank(payload);
      const job=await client.waitForJob(a,{timeoutMs:60000});
      console.log(JSON.stringify({event:'terminal',jobId:job.id,status:job.status,result:job.result,error:job.error,attempt:job.attempt,assignedGpuUuid:job.assignedGpuUuid,assignedWorkerId:job.assignedWorkerId}));
      verify(job,payload);
      console.log('PASS: remote CUDA ranking matches independent integer reference');
    } else {
      const {job}=await (action==='get'?client.getJob(a):client.cancelJob(a));
      console.log(JSON.stringify({jobId:job.id,status:job.status,result:job.result,attempt:job.attempt}));
    }
  }
} catch(e) {
  console.error('FAIL:',e.code ?? e.name, e.message);
  process.exitCode=1;
}
