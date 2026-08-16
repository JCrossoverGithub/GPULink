import assert from "node:assert/strict";
import test from "node:test";
import { createTestContext, gpu, registerWorker, submitJob } from "./helpers.mjs";

test("only the lease holder can start and finish a job", () => {
  const context = createTestContext();
  try {
    const worker = registerWorker(context, {
      name: "lifecycle-worker",
      gpus: [gpu({ uuid: "GPU-LIFECYCLE", memoryTotalMiB: 8192 })],
    });
    let job = submitJob(context);

    assert.throws(
      () => context.service.startJob(job.id, { workerId: "wrong", leaseId: job.leaseId }),
      /job lease is not valid/u,
    );

    job = context.service.startJob(job.id, {
      workerId: worker.id,
      leaseId: job.leaseId,
    });
    assert.equal(job.status, "running");

    job = context.service.finishJob(job.id, {
      workerId: worker.id,
      leaseId: job.leaseId,
      outcome: "succeeded",
      result: { verified: true },
    });
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.result, { verified: true });
  } finally {
    context.close();
  }
});

test("one GPU never receives two active jobs", () => {
  const context = createTestContext();
  try {
    registerWorker(context, {
      name: "exclusive-worker",
      gpus: [gpu({ uuid: "GPU-EXCLUSIVE", memoryTotalMiB: 24576 })],
    });
    const first = submitJob(context);
    const second = submitJob(context);
    assert.equal(first.status, "leased");
    assert.equal(second.status, "queued");
  } finally {
    context.close();
  }
});

test("stale workers become offline and their jobs are recovered", () => {
  const context = createTestContext({ heartbeatTimeoutMs: 1000, leaseDurationMs: 100_000 });
  try {
    registerWorker(context, {
      name: "stale-worker",
      gpus: [gpu({ uuid: "GPU-STALE", memoryTotalMiB: 8192 })],
    });
    const submitted = submitJob(context);
    assert.equal(submitted.status, "leased");

    context.advance(1001);
    context.scheduler.runOnce();
    assert.equal(context.database.listWorkers()[0].status, "offline");
    assert.equal(context.database.getJob(submitted.id).status, "queued");
  } finally {
    context.close();
  }
});

test("an expired lease cannot be started, renewed, or completed", () => {
  const context = createTestContext({ leaseDurationMs: 1000, heartbeatTimeoutMs: 100_000 });
  try {
    const worker = registerWorker(context, {
      name: "expired-worker",
      gpus: [gpu({ uuid: "GPU-EXPIRED", memoryTotalMiB: 8192 })],
    });
    const job = submitJob(context);
    context.advance(1001);

    assert.throws(
      () => context.service.startJob(job.id, { workerId: worker.id, leaseId: job.leaseId }),
      /job lease is not valid/u,
    );
    assert.throws(
      () => context.service.finishJob(job.id, {
        workerId: worker.id,
        leaseId: job.leaseId,
        outcome: "succeeded",
      }),
      /job lease is not valid/u,
    );
  } finally {
    context.close();
  }
});
