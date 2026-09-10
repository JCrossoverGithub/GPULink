import assert from "node:assert/strict";
import test from "node:test";
import {
  createTestContext,
  gpu,
  registerWorker,
  submitJob,
} from "./helpers.mjs";

test("scheduler chooses the smallest sufficient GPU in a heterogeneous fleet", async () => {
  const context = createTestContext();

  try {
    const small = await registerWorker(
      context,
      {
        name: "small-worker",
        gpus: [
          gpu({
            uuid: "GPU-8GB",
            memoryTotalMiB: 8192,
          }),
        ],
      },
    );

    const large = await registerWorker(
      context,
      {
        name: "large-worker",
        gpus: [
          gpu({
            uuid: "GPU-24GB",
            memoryTotalMiB: 24576,
          }),
        ],
      },
    );

    const smallJob = await submitJob(
      context,
      {
        constraints: {
          minVramMiB: 6000,
          capabilities: [
            "diagnostic.echo",
          ],
        },
      },
    );

    assert.equal(
      smallJob.status,
      "leased",
    );
    assert.equal(
      smallJob.assignedWorkerId,
      small.id,
    );
    assert.equal(
      smallJob.assignedGpuUuid,
      "GPU-8GB",
    );

    const largeJob = await submitJob(
      context,
      {
        constraints: {
          minVramMiB: 20000,
          capabilities: [
            "diagnostic.echo",
          ],
        },
      },
    );

    assert.equal(
      largeJob.status,
      "leased",
    );
    assert.equal(
      largeJob.assignedWorkerId,
      large.id,
    );
    assert.equal(
      largeJob.assignedGpuUuid,
      "GPU-24GB",
    );
  } finally {
    await context.close();
  }
});

test("scheduler ignores drained workers and leaves unsatisfied jobs queued", async () => {
  const context = createTestContext();

  try {
    const worker = await registerWorker(
      context,
      {
        name: "drained-worker",
        gpus: [
          gpu({
            uuid: "GPU-DRAINED",
            memoryTotalMiB: 24576,
          }),
        ],
      },
    );

    await context.service.setWorkerDrain(
      worker.id,
      { drain: true },
    );

    const job =
      await submitJob(context, {
        constraints: {
          minVramMiB: 1000,
          capabilities: [
            "diagnostic.echo",
          ],
        },
      });

    assert.equal(job.status, "queued");
    assert.equal(
      job.assignedWorkerId,
      null,
    );
  } finally {
    await context.close();
  }
});

test("warm model locality is preferred before utilization and VRAM headroom", async () => {
  const context = createTestContext();

  try {
    await registerWorker(context, {
      name: "cold-worker",
      gpus: [
        gpu({
          uuid: "GPU-COLD",
          memoryTotalMiB: 8192,
          utilizationPercent: 0,
        }),
      ],
    });

    const warm = await registerWorker(
      context,
      {
        name: "warm-worker",
        warmModels: ["example/model"],
        gpus: [
          gpu({
            uuid: "GPU-WARM",
            memoryTotalMiB: 24576,
            utilizationPercent: 60,
          }),
        ],
      },
    );

    const job =
      await submitJob(context, {
        constraints: {
          minVramMiB: 1000,
          capabilities: [
            "diagnostic.echo",
          ],
          model: "example/model",
        },
      });

    assert.equal(
      job.assignedWorkerId,
      warm.id,
    );
  } finally {
    await context.close();
  }
});

test("cached model locality is preferred after warm locality and before utilization", async () => {
  const context = createTestContext();

  try {
    const cached = await registerWorker(
      context,
      {
        name: "cached-worker",
        modelInventory: [
          {
            schemaVersion: 1,
            modelId: "example/model",
            revision: "main",
            adapterType:
              "speech.streaming",
          },
        ],
        gpus: [
          gpu({
            uuid: "GPU-CACHED",
            memoryTotalMiB: 8192,
            utilizationPercent: 60,
          }),
        ],
      },
    );

    await registerWorker(context, {
      name: "cold-worker",
      gpus: [
        gpu({
          uuid: "GPU-COLD-CACHE",
          memoryTotalMiB: 8192,
          utilizationPercent: 0,
        }),
      ],
    });

    const job =
      await submitJob(context, {
        constraints: {
          minVramMiB: 1000,
          capabilities: [
            "diagnostic.echo",
          ],
          model: "example/model",
        },
      });

    assert.equal(
      job.assignedWorkerId,
      cached.id,
    );
  } finally {
    await context.close();
  }
});

test("expired leases are requeued and fail after bounded attempts", async () => {
  const context = createTestContext({
    leaseDurationMs: 1000,
    heartbeatTimeoutMs: 100_000,
  });

  try {
    await registerWorker(context, {
      name: "retry-worker",
      gpus: [
        gpu({
          uuid: "GPU-RETRY",
          memoryTotalMiB: 8192,
        }),
      ],
    });

    let job = await submitJob(
      context,
      { maxAttempts: 2 },
    );

    assert.equal(job.status, "leased");
    assert.equal(job.attempt, 1);

    context.advance(1001);

    await context.scheduler.runOnce();

    job = await context.database.getJob(
      job.id,
    );

    assert.equal(job.status, "leased");
    assert.equal(job.attempt, 2);
    assert.notEqual(job.leaseId, null);

    const events =
      await context.database
        .listEventsAfter(0);

    const requeuedEvent =
      events.find(
        (event) =>
          event.type ===
            "job.requeued" &&
          event.subjectId === job.id,
      );

    assert.deepEqual(
      requeuedEvent?.payload,
      {
        reason: "lease_expired",
        attempt: 1,
      },
    );

    context.advance(1001);

    await context.scheduler.runOnce();

    job = await context.database.getJob(
      job.id,
    );

    assert.equal(job.status, "failed");
    assert.equal(
      job.error.code,
      "lease_exhausted",
    );
  } finally {
    await context.close();
  }
});

test("project idempotency key returns the original job", async () => {
  const context = createTestContext();

  try {
    const first =
      await context.service.submitJob(
        {
          projectId: "transgo",
          type: "speech.streaming",
          constraints: {
            minVramMiB: 8192,
          },
        },
        "session-request-1",
      );

    const second =
      await context.service.submitJob(
        {
          projectId: "transgo",
          type: "speech.streaming",
          constraints: {
            minVramMiB: 8192,
          },
        },
        "session-request-1",
      );

    assert.equal(
      first.duplicate,
      false,
    );
    assert.equal(
      second.duplicate,
      true,
    );
    assert.equal(
      second.job.id,
      first.job.id,
    );

    const jobs =
      await context.database.listJobs();

    assert.equal(jobs.length, 1);
  } finally {
    await context.close();
  }
});
