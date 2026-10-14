import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestContext,
  gpu,
  registerWorker,
  submitJob,
} from "./helpers.mjs";

async function createAllocatedSession(
  context,
  {
    workerName = "session-worker",
    gpuUuid = "GPU-SESSION-LIFECYCLE",
    capabilities = [
      "speech.streaming",
    ],
  } = {},
) {
  const worker =
    await registerWorker(
      context,
      {
        name: workerName,
        capabilities,
        gpus: [
          gpu({
            uuid: gpuUuid,
            memoryTotalMiB:
              24_576,
          }),
        ],
      },
    );

  const result =
    await context.service
      .submitSession(
        {
          projectId:
            "session-lifecycle-test",
          capability:
            "speech.streaming",
          requirements: {
            minVramMiB: 1_000,
            capabilities: [
              "speech.streaming",
            ],
          },
        },
        `request-${gpuUuid}`,
      );

  assert.equal(
    result.session.status,
    "allocated",
  );

  return {
    worker,
    session: result.session,
  };
}

test(
  "session follows allocated to connecting to active to closed",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 10_000,
      });

    try {
      const {
        worker,
        session: allocated,
      } =
        await createAllocatedSession(
          context,
        );

      const leaseId =
        allocated.leaseId;

      assert.match(
        leaseId,
        /^lease_/u,
      );

      context.advance(250);

      const connecting =
        await context.service
          .startSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId,
            },
          );

      assert.equal(
        connecting.status,
        "connecting",
      );

      assert.equal(
        connecting.leaseExpiresAt,
        context.clock() +
          context.config
            .leaseDurationMs,
      );

      context.advance(250);

      const active =
        await context.service
          .activateSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId,
            },
          );

      assert.equal(
        active.status,
        "active",
      );

      assert.equal(
        active.leaseExpiresAt,
        context.clock() +
          context.config
            .leaseDurationMs,
      );

      context.advance(250);

      const renewed =
        await context.service
          .renewSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId,
            },
          );

      assert.equal(
        renewed.status,
        "active",
      );

      assert.equal(
        renewed.leaseExpiresAt,
        context.clock() +
          context.config
            .leaseDurationMs,
      );

      const beforeCloseEvents =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            allocated.id,
        );

      assert.deepEqual(
        beforeCloseEvents.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.allocated",
          "session.connecting",
          "session.active",
        ],
      );

      const closed =
        await context.service
          .closeSession(
            allocated.id,
          );

      assert.equal(
        closed.status,
        "closed",
      );

      assert.equal(
        closed.assignedWorkerId,
        null,
      );

      assert.equal(
        closed.assignedGpuUuid,
        null,
      );

      assert.equal(
        closed.leaseId,
        null,
      );

      assert.equal(
        closed.leaseExpiresAt,
        null,
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            allocated.id,
        );

      assert.deepEqual(
        events.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.allocated",
          "session.connecting",
          "session.active",
          "session.closed",
        ],
      );

      assert.deepEqual(
        events.at(-1)?.payload,
        {
          previousStatus: "active",
        },
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "only the current session lease holder can advance or renew",
  async () => {
    const context =
      createTestContext();

    try {
      const {
        worker,
        session,
      } =
        await createAllocatedSession(
          context,
        );

      await assert.rejects(
        () =>
          context.service
            .startSession(
              session.id,
              {
                workerId:
                  "worker-wrong",
                leaseId:
                  session.leaseId,
              },
            ),
        /session lease is not valid for this worker/u,
      );

      await assert.rejects(
        () =>
          context.service
            .startSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  "lease-wrong",
              },
            ),
        /session lease is not valid for this worker/u,
      );

      let stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "allocated",
      );

      const connecting =
        await context.service
          .startSession(
            session.id,
            {
              workerId:
                worker.id,
              leaseId:
                session.leaseId,
            },
          );

      await assert.rejects(
        () =>
          context.service
            .activateSession(
              session.id,
              {
                workerId:
                  "worker-wrong",
                leaseId:
                  session.leaseId,
              },
            ),
        /connecting session lease is not valid for this worker/u,
      );

      await assert.rejects(
        () =>
          context.service
            .activateSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  "lease-wrong",
              },
            ),
        /connecting session lease is not valid for this worker/u,
      );

      stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "connecting",
      );

      const active =
        await context.service
          .activateSession(
            session.id,
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

      await assert.rejects(
        () =>
          context.service
            .renewSession(
              session.id,
              {
                workerId:
                  "worker-wrong",
                leaseId:
                  active.leaseId,
              },
            ),
        /session lease is not valid for this worker/u,
      );

      await assert.rejects(
        () =>
          context.service
            .renewSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  "lease-wrong",
              },
            ),
        /session lease is not valid for this worker/u,
      );

      stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "active",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "expired allocated session cannot enter connecting",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const {
        worker,
        session,
      } =
        await createAllocatedSession(
          context,
        );

      context.advance(1_001);

      await assert.rejects(
        () =>
          context.service
            .startSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  session.leaseId,
              },
            ),
        /session lease is not valid for this worker/u,
      );

      const stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "allocated",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "expired connecting session cannot become active",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const {
        worker,
        session,
      } =
        await createAllocatedSession(
          context,
        );

      const connecting =
        await context.service
          .startSession(
            session.id,
            {
              workerId:
                worker.id,
              leaseId:
                session.leaseId,
            },
          );

      context.advance(1_001);

      await assert.rejects(
        () =>
          context.service
            .activateSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  connecting.leaseId,
              },
            ),
        /connecting session lease is not valid for this worker/u,
      );

      const stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "connecting",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "expired active session cannot renew",
  async () => {
    const context =
      createTestContext({
        leaseDurationMs: 1_000,
        heartbeatTimeoutMs:
          100_000,
      });

    try {
      const {
        worker,
        session,
      } =
        await createAllocatedSession(
          context,
        );

      const connecting =
        await context.service
          .startSession(
            session.id,
            {
              workerId:
                worker.id,
              leaseId:
                session.leaseId,
            },
          );

      const active =
        await context.service
          .activateSession(
            session.id,
            {
              workerId:
                worker.id,
              leaseId:
                connecting.leaseId,
            },
          );

      context.advance(1_001);

      await assert.rejects(
        () =>
          context.service
            .renewSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  active.leaseId,
              },
            ),
        /session lease is not valid for this worker/u,
      );

      const stored =
        await context.database
          .getSession(session.id);

      assert.equal(
        stored.status,
        "active",
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "allocated connecting and active sessions may be closed",
  async () => {
    for (
      const targetState
      of [
        "allocated",
        "connecting",
        "active",
      ]
    ) {
      const context =
        createTestContext();

      try {
        const {
          worker,
          session,
        } =
          await createAllocatedSession(
            context,
            {
              workerName:
                `worker-${targetState}`,
              gpuUuid:
                `GPU-CLOSE-${targetState}`,
            },
          );

        if (
          targetState ===
          "connecting" ||
          targetState ===
          "active"
        ) {
          await context.service
            .startSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  session.leaseId,
              },
            );
        }

        if (
          targetState ===
          "active"
        ) {
          await context.service
            .activateSession(
              session.id,
              {
                workerId:
                  worker.id,
                leaseId:
                  session.leaseId,
              },
            );
        }

        const before =
          await context.database
            .getSession(session.id);

        assert.equal(
          before.status,
          targetState,
        );

        const closed =
          await context.service
            .closeSession(
              session.id,
            );

        assert.equal(
          closed.status,
          "closed",
        );

        assert.equal(
          closed.assignedWorkerId,
          null,
        );

        assert.equal(
          closed.assignedGpuUuid,
          null,
        );

        assert.equal(
          closed.leaseId,
          null,
        );

        assert.equal(
          closed.leaseExpiresAt,
          null,
        );

        const events =
          await context.database
            .listEventsAfter(0);

        const closedEvent =
          events.find(
            (event) =>
              event.type ===
                "session.closed" &&
              event.subjectId ===
                session.id,
          );

        assert.deepEqual(
          closedEvent?.payload,
          {
            previousStatus:
              targetState,
          },
        );
      } finally {
        await context.close();
      }
    }
  },
);

test(
  "closing a session immediately releases its GPU to queued work",
  async () => {
    const context =
      createTestContext();

    try {
      await registerWorker(
        context,
        {
          name:
            "release-worker",
          capabilities: [
            "diagnostic.echo",
            "speech.streaming",
          ],
          gpus: [
            gpu({
              uuid:
                "GPU-RELEASE",
              memoryTotalMiB:
                24_576,
            }),
          ],
        },
      );

      const result =
        await context.service
          .submitSession(
            {
              projectId:
                "release-test",
              capability:
                "speech.streaming",
              requirements: {
                minVramMiB:
                  1_000,
                capabilities: [
                  "speech.streaming",
                ],
              },
            },
          );

      assert.equal(
        result.session.status,
        "allocated",
      );

      const queued =
        await submitJob(
          context,
        );

      assert.equal(
        queued.status,
        "queued",
      );

      await context.service
        .closeSession(
          result.session.id,
        );

      const scheduled =
        await context.database
          .getJob(queued.id);

      assert.equal(
        scheduled.status,
        "leased",
      );

      assert.equal(
        scheduled.assignedGpuUuid,
        "GPU-RELEASE",
      );

      const closed =
        await context.database
          .getSession(
            result.session.id,
          );

      assert.equal(
        closed.status,
        "closed",
      );

      assert.equal(
        closed.assignedGpuUuid,
        null,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "closed and missing sessions reject repeated close operations",
  async () => {
    const context =
      createTestContext();

    try {
      const {
        session,
      } =
        await createAllocatedSession(
          context,
        );

      await context.service
        .closeSession(
          session.id,
        );

      await assert.rejects(
        () =>
          context.service
            .closeSession(
              session.id,
            ),
        /session cannot be closed from closed/u,
      );

      await assert.rejects(
        () =>
          context.service
            .closeSession(
              "session-missing",
            ),
        /session not found/u,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "requested session may be closed before allocation",
  async () => {
    const context =
      createTestContext();

    try {
      const result =
        await context.service
          .submitSession({
            projectId:
              "requested-close-test",
            capability:
              "speech.streaming",
            requirements: {
              minVramMiB: 1_000,
              capabilities: [
                "speech.streaming",
              ],
            },
          });

      assert.equal(
        result.session.status,
        "requested",
      );

      const closed =
        await context.service
          .closeSession(
            result.session.id,
          );

      assert.equal(
        closed.status,
        "closed",
      );

      assert.equal(
        closed.assignedWorkerId,
        null,
      );

      assert.equal(
        closed.assignedGpuUuid,
        null,
      );

      assert.equal(
        closed.leaseId,
        null,
      );

      const events =
        (
          await context.database
            .listEventsAfter(0)
        ).filter(
          (event) =>
            event.subjectId ===
            result.session.id,
        );

      assert.deepEqual(
        events.map(
          (event) => event.type,
        ),
        [
          "session.requested",
          "session.closed",
        ],
      );

      assert.deepEqual(
        events.at(-1)?.payload,
        {
          previousStatus:
            "requested",
        },
      );
    } finally {
      await context.close();
    }
  },
);
