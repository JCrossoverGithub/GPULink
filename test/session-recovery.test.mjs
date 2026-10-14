import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestContext,
  gpu,
  registerWorker,
  submitJob,
} from "./helpers.mjs";

async function requestRecoverableSession(
  context,
  {
    maxInterruptions = 1,
    minVramMiB = 1_000,
  } = {},
) {
  return context.service.submitSession({
    projectId:
      "session-recovery-test",
    capability:
      "speech.streaming",
    requirements: {
      minVramMiB,
      capabilities: [
        "speech.streaming",
      ],
    },
    recovery: {
      maxInterruptions,
    },
  });
}

test(
  "maxInterruptions zero makes the first expired allocation terminally interrupted",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      await registerWorker(
        context,
        {
          name:
            "terminal-worker",
          capabilities: [
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-TERMINAL",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const initial =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 0,
            },
          )
        ).session;

      assert.equal(
        initial.status,
        "allocated",
      );

      const oldLeaseId =
        initial.leaseId;

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const recovered =
        await context.database
          .getSession(initial.id);

      assert.equal(
        recovered.status,
        "interrupted",
      );

      assert.equal(
        recovered.interruptionCount,
        1,
      );

      assert.equal(
        recovered.assignedWorkerId,
        null,
      );

      assert.equal(
        recovered.assignedGpuUuid,
        null,
      );

      assert.equal(
        recovered.leaseId,
        null,
      );

      assert.equal(
        recovered.leaseExpiresAt,
        null,
      );

      assert.notEqual(
        oldLeaseId,
        null,
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            initial.id,
        );

      assert.deepEqual(
        events.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.allocated",
          "session.interrupted",
        ],
      );

      assert.deepEqual(
        events.at(-1)?.payload,
        {
          reason:
            "lease_expired",
          previousStatus:
            "allocated",
          interruptionCount: 1,
        },
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "one permitted interruption receives a replacement allocation with a new lease",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const worker =
        await registerWorker(
          context,
          {
            name:
              "replacement-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-REPLACEMENT",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      const initial =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 1,
            },
          )
        ).session;

      const oldLeaseId =
        initial.leaseId;

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const replacement =
        await context.database
          .getSession(initial.id);

      assert.equal(
        replacement.status,
        "allocated",
      );

      assert.equal(
        replacement.interruptionCount,
        1,
      );

      assert.equal(
        replacement.assignedWorkerId,
        worker.id,
      );

      assert.equal(
        replacement.assignedGpuUuid,
        "GPU-REPLACEMENT",
      );

      assert.match(
        replacement.leaseId,
        /^lease_/u,
      );

      assert.notEqual(
        replacement.leaseId,
        oldLeaseId,
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            initial.id,
        );

      assert.deepEqual(
        events.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.allocated",
          "session.interrupted",
          "session.requeued",
          "session.allocated",
        ],
      );

      const interrupted =
        events.find(
          (event) =>
            event.type ===
            "session.interrupted",
        );

      assert.deepEqual(
        interrupted?.payload,
        {
          reason:
            "lease_expired",
          previousStatus:
            "allocated",
          interruptionCount: 1,
        },
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "stale lease cannot control a replacement allocation",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const worker =
        await registerWorker(
          context,
          {
            name:
              "stale-lease-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-STALE-LEASE",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      const initial =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 1,
            },
          )
        ).session;

      const staleLeaseId =
        initial.leaseId;

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const replacement =
        await context.database
          .getSession(initial.id);

      assert.notEqual(
        replacement.leaseId,
        staleLeaseId,
      );

      await assert.rejects(
        () =>
          context.service
            .startSession(
              initial.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  staleLeaseId,
              },
            ),
        /session lease is not valid for this worker/u,
      );

      const connecting =
        await context.service
          .startSession(
            initial.id,
            {
              workerId:
                worker.id,
              leaseId:
                replacement.leaseId,
            },
          );

      assert.equal(
        connecting.status,
        "connecting",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "replacement allowance is exhausted after the next allocation loss",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      await registerWorker(
        context,
        {
          name:
            "bounded-worker",
          capabilities: [
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-BOUNDED",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const initial =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 1,
            },
          )
        ).session;

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const firstReplacement =
        await context.database
          .getSession(initial.id);

      assert.equal(
        firstReplacement.status,
        "allocated",
      );

      assert.equal(
        firstReplacement.interruptionCount,
        1,
      );

      const replacementLeaseId =
        firstReplacement.leaseId;

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const exhausted =
        await context.database
          .getSession(initial.id);

      assert.equal(
        exhausted.status,
        "interrupted",
      );

      assert.equal(
        exhausted.interruptionCount,
        2,
      );

      assert.equal(
        exhausted.assignedWorkerId,
        null,
      );

      assert.equal(
        exhausted.assignedGpuUuid,
        null,
      );

      assert.equal(
        exhausted.leaseId,
        null,
      );

      assert.notEqual(
        replacementLeaseId,
        null,
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            initial.id,
        );

      assert.deepEqual(
        events.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.allocated",
          "session.interrupted",
          "session.requeued",
          "session.allocated",
          "session.interrupted",
        ],
      );

      assert.equal(
        events.filter(
          (event) =>
            event.type ===
            "session.requeued",
        ).length,
        1,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "stale worker loss reallocates to a fresh eligible worker",
  async () => {
    const context =
      createTestContext({
        heartbeatTimeoutMs: 1_000,
        leaseDurationMs:
          100_000,
      });

    try {
      const original =
        await registerWorker(
          context,
          {
            name:
              "original-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-ORIGINAL",
                memoryTotalMiB:
                  24_576,
                utilizationPercent: 0,
              }),
            ],
          },
        );

      const initial =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 1,
            },
          )
        ).session;

      assert.equal(
        initial.assignedWorkerId,
        original.id,
      );

      const oldLeaseId =
        initial.leaseId;

      context.advance(1_001);

      const replacementWorker =
        await registerWorker(
          context,
          {
            name:
              "fresh-replacement-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-FRESH",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      await context.scheduler
        .runOnce();

      const recovered =
        await context.database
          .getSession(initial.id);

      assert.equal(
        recovered.status,
        "allocated",
      );

      assert.equal(
        recovered.interruptionCount,
        1,
      );

      assert.equal(
        recovered.assignedWorkerId,
        replacementWorker.id,
      );

      assert.equal(
        recovered.assignedGpuUuid,
        "GPU-FRESH",
      );

      assert.notEqual(
        recovered.leaseId,
        oldLeaseId,
      );

      const workers =
        await context.database
          .listWorkers();

      const originalStored =
        workers.find(
          (worker) =>
            worker.id ===
            original.id,
        );

      assert.equal(
        originalStored?.status,
        "offline",
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            initial.id,
        );

      const interruption =
        events.find(
          (event) =>
            event.type ===
            "session.interrupted",
        );

      assert.deepEqual(
        interruption?.payload,
        {
          reason:
            "heartbeat_timeout",
          previousStatus:
            "allocated",
          interruptionCount: 1,
        },
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "terminal interruption releases the GPU to queued jobs in the same scheduler pass",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      await registerWorker(
        context,
        {
          name:
            "release-on-loss-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-LOSS-RELEASE",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const session =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 0,
            },
          )
        ).session;

      const job =
        await submitJob(context);

      assert.equal(
        job.status,
        "queued",
      );

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const interrupted =
        await context.database
          .getSession(session.id);

      const leasedJob =
        await context.database
          .getJob(job.id);

      assert.equal(
        interrupted.status,
        "interrupted",
      );

      assert.equal(
        interrupted.assignedGpuUuid,
        null,
      );

      assert.equal(
        leasedJob.status,
        "leased",
      );

      assert.equal(
        leasedJob.assignedGpuUuid,
        "GPU-LOSS-RELEASE",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "recovery from an active session records its previous state",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const worker =
        await registerWorker(
          context,
          {
            name:
              "active-recovery-worker",
            capabilities: [
              "speech.streaming",
            ],
            gpus: [
              gpu({
                uuid:
                  "GPU-ACTIVE-RECOVERY",
                memoryTotalMiB:
                  24_576,
              }),
            ],
          },
        );

      const allocated =
        (
          await requestRecoverableSession(
            context,
            {
              maxInterruptions: 0,
            },
          )
        ).session;

      const connecting =
        await context.service
          .startSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId:
                allocated.leaseId,
            },
          );

      const active =
        await context.service
          .activateSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId:
                connecting.leaseId,
            },
          );

      assert.equal(
        active.status,
        "active",
      );

      context.advance(1_001);

      await context.scheduler
        .runOnce();

      const recovered =
        await context.database
          .getSession(active.id);

      assert.equal(
        recovered.status,
        "interrupted",
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            active.id,
        );

      const interruption =
        events.find(
          (event) =>
            event.type ===
            "session.interrupted",
        );

      assert.deepEqual(
        interruption?.payload,
        {
          reason:
            "lease_expired",
          previousStatus:
            "active",
          interruptionCount: 1,
        },
      );
    } finally {
      await context.close();
    }
  },
);
