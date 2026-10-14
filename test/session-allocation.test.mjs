import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestContext,
  gpu,
  registerWorker,
  submitJob,
} from "./helpers.mjs";

function requestSession(
  context,
  overrides = {},
  idempotencyKey = null,
) {
  return context.service.submitSession(
    {
      projectId: "session-test",
      capability:
        "speech.streaming",
      requirements: {
        minVramMiB: 1_000,
        capabilities: [
          "speech.streaming",
        ],
      },
      ...overrides,
    },
    idempotencyKey,
  );
}

test(
  "scheduler allocates a requested session and records lifecycle events",
  async () => {
    const context =
      createTestContext();

    try {
      const worker =
        await registerWorker(
          context,
          {
            name:
              "session-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-SESSION",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      const result =
        await requestSession(
          context,
          {
            requirements: {
              minVramMiB:
                16_384,
              capabilities: [
                "speech.streaming",
              ],
            },
          },
          "session-allocation-1",
        );

      assert.equal(
        result.duplicate,
        false,
      );

      assert.equal(
        result.session.status,
        "allocated",
      );

      assert.equal(
        result.session
          .assignedWorkerId,
        worker.id,
      );

      assert.equal(
        result.session
          .assignedGpuUuid,
        "GPU-SESSION",
      );

      assert.match(
        result.session.leaseId,
        /^lease_/u,
      );

      assert.equal(
        result.session
          .leaseExpiresAt,
        context.clock() +
          context.config
            .leaseDurationMs,
      );

      const events =
        await context.database
          .listEventsAfter(0);

      assert.ok(
        events.some(
          (event) =>
            event.type ===
              "session.requested" &&
            event.subjectId ===
              result.session.id,
        ),
      );

      assert.ok(
        events.some(
          (event) =>
            event.type ===
              "session.allocated" &&
            event.subjectId ===
              result.session.id &&
            event.payload
              .workerId ===
              worker.id &&
            event.payload
              .gpuUuid ===
              "GPU-SESSION",
        ),
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "an active job blocks a session from the same GPU",
  async () => {
    const context =
      createTestContext();

    try {
      await registerWorker(
        context,
        {
          name:
            "job-first-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-JOB-FIRST",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const job =
        await submitJob(context);

      assert.equal(
        job.status,
        "leased",
      );

      const result =
        await requestSession(
          context,
        );

      assert.equal(
        result.session.status,
        "requested",
      );

      assert.equal(
        result.session
          .assignedGpuUuid,
        null,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "an allocated session blocks a job from the same GPU",
  async () => {
    const context =
      createTestContext();

    try {
      await registerWorker(
        context,
        {
          name:
            "session-first-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-SESSION-FIRST",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const result =
        await requestSession(
          context,
        );

      assert.equal(
        result.session.status,
        "allocated",
      );

      const job =
        await submitJob(context);

      assert.equal(
        job.status,
        "queued",
      );

      assert.equal(
        job.assignedGpuUuid,
        null,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "a second GPU permits a job and session to coexist without overlap",
  async () => {
    const context =
      createTestContext();

    try {
      await registerWorker(
        context,
        {
          name:
            "two-gpu-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid: "GPU-SMALL",
              index: 0,
              memoryTotalMiB:
                8_192,
            }),
            gpu({
              uuid: "GPU-LARGE",
              index: 1,
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const session =
        (
          await requestSession(
            context,
          )
        ).session;

      const job =
        await submitJob(
          context,
        );

      assert.equal(
        session.status,
        "allocated",
      );

      assert.equal(
        job.status,
        "leased",
      );

      assert.notEqual(
        session.assignedGpuUuid,
        job.assignedGpuUuid,
      );

      assert.deepEqual(
        new Set([
          session.assignedGpuUuid,
          job.assignedGpuUuid,
        ]),
        new Set([
          "GPU-SMALL",
          "GPU-LARGE",
        ]),
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "drained and ineligible workers do not receive sessions",
  async () => {
    const context =
      createTestContext();

    try {
      const drained =
        await registerWorker(
          context,
          {
            name:
              "drained-session-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-DRAINED-SESSION",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      await context.service
        .setWorkerDrain(
          drained.id,
          {
            drain: true,
          },
        );

      await registerWorker(
        context,
        {
          name:
            "wrong-capability-worker",
          capabilities: [
            "diagnostic.echo",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-WRONG-CAP",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const result =
        await requestSession(
          context,
        );

      assert.equal(
        result.session.status,
        "requested",
      );

      assert.equal(
        result.session
          .assignedWorkerId,
        null,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "session idempotency returns the original allocation",
  async () => {
    const context =
      createTestContext();

    try {
      await registerWorker(
        context,
        {
          name:
            "idempotent-session-worker",
          capabilities: [
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-IDEMPOTENT-SESSION",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const first =
        await requestSession(
          context,
          {},
          "same-session-request",
        );

      const second =
        await requestSession(
          context,
          {
            priority: 999,
          },
          "same-session-request",
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
        second.session.id,
        first.session.id,
      );

      assert.equal(
        second.session.priority,
        first.session.priority,
      );

      assert.equal(
        (
          await context.database
            .listSessions()
        ).length,
        1,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "higher-priority session wins unified scheduling over an older queued job",
  async () => {
    const context =
      createTestContext();

    try {
      const job =
        await context.service
          .submitJob({
            projectId:
              "cross-type-priority-test",
            type:
              "diagnostic.echo",
            priority: 1,
            constraints: {
              gpuCount: 1,
              minVramMiB: 1_000,
              capabilities: [
                "diagnostic.echo",
              ],
            },
            payload: {
              echo:
                "older-lower-priority-job",
            },
            maxAttempts: 3,
          });

      assert.equal(
        job.job.status,
        "queued",
      );

      context.advance(1);

      const session =
        await requestSession(
          context,
          {
            projectId:
              "cross-type-priority-test",
            priority: 10,
          },
          "cross-type-priority-session",
        );

      assert.equal(
        session.session.status,
        "requested",
      );

      await registerWorker(
        context,
        {
          name:
            "cross-type-priority-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-CROSS-TYPE-PRIORITY",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      await context.scheduler
        .runOnce();

      const storedJob =
        await context.database
          .getJob(job.job.id);

      const storedSession =
        await context.database
          .getSession(
            session.session.id,
          );

      assert.equal(
        storedSession.status,
        "allocated",
      );

      assert.equal(
        storedSession.assignedGpuUuid,
        "GPU-CROSS-TYPE-PRIORITY",
      );

      assert.equal(
        storedJob.status,
        "queued",
      );

      assert.equal(
        storedJob.assignedGpuUuid,
        null,
      );
    } finally {
      await context.close();
    }
  },
);
