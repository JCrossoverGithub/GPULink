// Standalone application: imports only the installed, public GPULink SDK.
import assert from 'node:assert/strict';
import { GPULinkClient } from '@gpulink/client';

const client = new GPULinkClient({
  baseUrl: process.env.GPULINK_BASE_URL,
  token: process.env.GPULINK_CLIENT_TOKEN,
});

const submission = {
  projectId: 'phase5e-external-example',
  type: 'diagnostic.gpu-status',
  priority: 100,
  constraints: {
    gpuCount: 1,
    minVramMiB: 256,
    capabilities: ['diagnostic.gpu-status'],
  },
  payload: {},
  maxAttempts: 2,
};

const idempotencyKey = `phase5e-example-${process.pid}`;
const created = await client.submitJob(submission, { idempotencyKey });
assert.equal(created.duplicate, false);
assert.equal(typeof created.job.id, 'string');

const repeated = await client.submitJob(submission, { idempotencyKey });
assert.equal(repeated.duplicate, true);
assert.equal(repeated.job.id, created.job.id);

const fetched = await client.getJob(created.job.id);
assert.equal(fetched.job.id, created.job.id);
const listed = await client.listJobs({ limit: 20 });
assert.ok(listed.jobs.some((job) => job.id === created.job.id));

const cancelled = await client.cancelJob(created.job.id);
assert.equal(cancelled.job.status, 'cancelled');
console.log(JSON.stringify({ event: 'finite_job_complete', jobId: created.job.id }));
