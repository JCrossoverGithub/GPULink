// Independent SDK consumer: submit, get and cancel are separate processes.
import assert from 'node:assert/strict';
import { GPULinkClient } from '@gpulink/client';
const client = new GPULinkClient({baseUrl:process.env.GPULINK_BASE_URL,token:process.env.GPULINK_CLIENT_TOKEN});
const [action, value] = process.argv.slice(2);
if (action === 'submit' || action === 'submit-hold') {
  if (!value || value.length > 200) throw new Error('Supply a unique idempotency key');
  const {job,duplicate} = await client.submitJob({projectId:'external-matrix-batch-preview',
    type:'external.batch.matrix',constraints:{gpuCount:1,minVramMiB:1000},maxAttempts:1,
    payload:{values:[1,2,3,4],holdMs:action === 'submit-hold' ? 15000 : 0}}, {idempotencyKey:value});
  console.log(JSON.stringify({event:'batch_submitted',jobId:job.id,status:job.status,duplicate}));
} else if (action === 'get' || action === 'verify') {
  const {job} = await client.getJob(value);
  if (action === 'verify') {
    assert.equal(job.status,'succeeded');
    assert.equal(job.result.backend,'pytorch-cuda');
    assert.deepEqual(job.result.values,[11,16,11,14]);
    assert.ok(Number.isFinite(job.result.elapsedMs) && job.result.elapsedMs >= 0);
    assert.equal(job.leaseExpiresAt,null);
    assert.equal(job.attempt,1);
  }
  console.log(JSON.stringify({event:action==='verify'?'batch_cuda_pass':'batch_status',
    jobId:job.id,status:job.status,result:job.result,attempt:job.attempt,
    assignedGpuUuid:job.assignedGpuUuid,assignedWorkerId:job.assignedWorkerId}));
} else if (action === 'cancel') {
  const {job}=await client.cancelJob(value);
  console.log(JSON.stringify({event:'batch_cancelled',jobId:job.id,status:job.status}));
} else throw new Error('Usage: node client.mjs submit|submit-hold KEY; get|verify|cancel JOB_ID');
