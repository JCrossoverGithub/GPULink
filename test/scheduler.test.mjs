import assert from "node:assert/strict";
import test from "node:test";
import { createTestContext, gpu, registerWorker, submitJob } from "./helpers.mjs";

test("scheduler chooses the smallest sufficient GPU in a heterogeneous fleet", () => {
  const context = createTestContext();
  try {
    const small = registerWorker(context, {
      name: "small-worker",
      gpus: [gpu({ uuid: "GPU-8GB", memoryTotalMiB: 8192 })],
    });
    const large = registerWorker(context, {
      name: "large-worker",
      gpus: [gpu({ uuid: "GPU-24GB", memoryTotalMiB: 24576 })],
    });

    const smallJob = submitJob(context, {
      constraints: { minVramMiB: 6000, capabilities: ["diagnostic.echo"] },
    });
    assert.equal(smallJob.status, "leased");
    assert.equal(smallJob.assignedWorkerId, small.id);
    assert.equal(smallJob.assignedGpuUuid, "GPU-8GB");

    const largeJob = submitJob(context, {
      constraints: { minVramMiB: 20000, capabilities: ["diagnostic.echo"] },
    });
    assert.equal(largeJob.status, "leased");
    assert.equal(largeJob.assignedWorkerId, large.id);
    assert.equal(largeJob.assignedGpuUuid, "GPU-24GB");
  } finally {
    context.close();
  }
});

test("scheduler ignores drained workers and leaves unsatisfied jobs queued", () => {
  const context = createTestContext();
  try {
    const worker = registerWorker(context, {
      name: "drained-worker",
      gpus: [gpu({ uuid: "GPU-DRAINED", memoryTotalMiB: 24576 })],
    });
    context.service.setWorkerDrain(worker.id, { drain: true });

    const job = submitJob(context, {
      constraints: { minVramMiB: 1000, capabilities: ["diagnostic.echo"] },
    });
    assert.equal(job.status, "queued");
    assert.equal(job.assignedWorkerId, null);
  } finally {
    context.close();
  }
});

test("warm model locality is preferred before utilization and VRAM headroom", () => {
  const context = createTestContext();
  try {
    registerWorker(context, {
      name: "cold-worker",
      gpus: [gpu({ uuid: "GPU-COLD", memoryTotalMiB: 8192, utilizationPercent: 0 })],
    });
    const warm = registerWorker(context, {
      name: "warm-worker",
      warmModels: ["example/model"],
      gpus: [gpu({ uuid: "GPU-WARM", memoryTotalMiB: 24576, utilizationPercent: 60 })],
    });

    const job = submitJob(context, {
      constraints: {
        minVramMiB: 1000,
        capabilities: ["diagnostic.echo"],
        model: "example/model",
      },
    });
    assert.equal(job.assignedWorkerId, warm.id);
  } finally {
    context.close();
  }
});

test("cached model locality is preferred after warm locality and before utilization", () => {
  const context = createTestContext();
  try {
    const cached = registerWorker(context, {
      name: "cached-worker",
      modelInventory: [{
        schemaVersion: 1,
        modelId: "example/model",
        revision: "main",
        adapterType: "speech.streaming",
      }],
      gpus: [gpu({ uuid: "GPU-CACHED", memoryTotalMiB: 8192, utilizationPercent: 60 })],
    });
    registerWorker(context, {
      name: "cold-worker",
      gpus: [gpu({ uuid: "GPU-COLD-CACHE", memoryTotalMiB: 8192, utilizationPercent: 0 })],
    });

    const job = submitJob(context, {
      constraints: {
        minVramMiB: 1000,
        capabilities: ["diagnostic.echo"],
        model: "example/model",
      },
    });
    assert.equal(job.assignedWorkerId, cached.id);
  } finally {
    context.close();
  }
});

test("expired leases are requeued and fail after bounded attempts", () => {
  const context = createTestContext({ leaseDurationMs: 1000, heartbeatTimeoutMs: 100_000 });
  try {
    registerWorker(context, {
      name: "retry-worker",
      gpus: [gpu({ uuid: "GPU-RETRY", memoryTotalMiB: 8192 })],
    });
    let job = submitJob(context, { maxAttempts: 2 });
    assert.equal(job.status, "leased");
    assert.equal(job.attempt, 1);

    context.advance(1001);
    context.scheduler.runOnce();
    job = context.database.getJob(job.id);
    assert.equal(job.status, "leased");
    assert.equal(job.attempt, 2);
    assert.notEqual(job.leaseId, null);

    context.advance(1001);
    context.scheduler.runOnce();
    job = context.database.getJob(job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "lease_exhausted");
  } finally {
    context.close();
  }
});

test("project idempotency key returns the original job", () => {
  const context = createTestContext();
  try {
    const first = context.service.submitJob({
      projectId: "transgo",
      type: "speech.streaming",
      constraints: { minVramMiB: 8192 },
    }, "session-request-1");
    const second = context.service.submitJob({
      projectId: "transgo",
      type: "speech.streaming",
      constraints: { minVramMiB: 8192 },
    }, "session-request-1");

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(context.database.listJobs().length, 1);
  } finally {
    context.close();
  }
});
