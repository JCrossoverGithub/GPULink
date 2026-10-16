import { createId } from "../shared/ids.mjs";

export class Scheduler {
  #tail = Promise.resolve();

  constructor(database, {
    heartbeatTimeoutMs,
    leaseDurationMs,
    vramSafetyMiB,
    clock = () => Date.now(),
  }) {
    this.database = database;
    this.heartbeatTimeoutMs =
      heartbeatTimeoutMs;
    this.leaseDurationMs =
      leaseDurationMs;
    this.vramSafetyMiB =
      vramSafetyMiB;
    this.clock = clock;
  }

  runOnce() {
    const run = this.#tail.then(
      () => this.#runOnce(),
      () => this.#runOnce(),
    );

    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async #runOnce() {
    return this.database.transaction(
      async (transaction) => {
        const acquired =
          await transaction
            .tryAcquireSchedulerLock();

        if (!acquired) {
          return {
            acquired: false,
            staleWorkerIds: [],
            recoveredJobs: [],
            assigned: [],
          };
        }

        const now = this.clock();

        const staleWorkerIds =
          await transaction
            .markStaleWorkersOffline(
              now -
                this.heartbeatTimeoutMs,
              now,
            );

        for (
          const workerId
          of staleWorkerIds
        ) {
          await transaction.appendEvent(
            "worker.offline",
            workerId,
            {
              reason:
                "heartbeat_timeout",
            },
            now,
          );
        }

        const recoveries =
          await transaction
            .recoverExpiredJobs(
              now,
              staleWorkerIds,
            );

        for (
          const { job, reason }
          of recoveries
        ) {
          await transaction.appendEvent(
            job.status === "queued"
              ? "job.requeued"
              : "job.failed",
            job.id,
            {
              reason,
              attempt: job.attempt,
            },
            now,
          );
        }

        const sessionRecoveries =
          await transaction
            .recoverInterruptedSessions(
              now,
              staleWorkerIds,
            );

        for (
          const {
            session,
            reason,
            previousStatus,
          }
          of sessionRecoveries
        ) {
          await transaction.appendEvent(
            "session.interrupted",
            session.id,
            {
              reason,
              previousStatus,
              interruptionCount:
                session.interruptionCount,
            },
            now,
          );

          if (
            session.status ===
            "requested"
          ) {
            await transaction.appendEvent(
              "session.requeued",
              session.id,
              {
                reason,
                interruptionCount:
                  session.interruptionCount,
              },
              now,
            );
          }
        }

        // A logical lease becoming free does NOT prove an old GPU
        // process was reaped. Committed durable holds block reuse.
        // Read under the same scheduler transaction as placement.
        const blockedGpuResources = new Set(
          (await transaction.listBlockedGpuResources())
            .map(({ workerId, gpuUuid }) =>
              resourceKey(workerId, gpuUuid)),
        );

        const workers =
          await transaction
            .listWorkers();

        const activeJobs =
          await transaction
            .listActiveJobs();

        const occupyingSessions =
          await transaction
            .listOccupyingSessions();

        const occupiedGpus =
          new Set(
            [
              ...activeJobs,
              ...occupyingSessions,
            ]
              .map(
                (workload) =>
                  workload
                    .assignedGpuUuid,
              )
              .filter(Boolean),
          );

        const queuedJobs =
          await transaction
            .listQueuedJobs();

        const requestedSessions =
          await transaction
            .listRequestedSessions();

        const pending = [
          ...queuedJobs.map(
            (item) => ({
              kind: "job",
              item,
            }),
          ),
          ...requestedSessions.map(
            (item) => ({
              kind: "session",
              item,
            }),
          ),
        ].sort(comparePendingWork);

        const assigned = [];

        for (
          const entry of pending
        ) {
          const placement =
            choosePlacement(
              entry.item,
              workers,
              occupiedGpus,
              {
                now,
                heartbeatTimeoutMs:
                  this
                    .heartbeatTimeoutMs,
                vramSafetyMiB:
                  this.vramSafetyMiB,
                blockedGpuResources,
              },
            );

          if (!placement) {
            continue;
          }

          const leaseId =
            createId("lease");

          const leaseExpiresAt =
            now +
            this.leaseDurationMs;

          if (entry.kind === "job") {
            const leasedJob =
              await transaction
                .assignJob(
                  entry.item.id,
                  placement,
                  leaseId,
                  leaseExpiresAt,
                  now,
                );

            if (!leasedJob) {
              continue;
            }

            occupiedGpus.add(
              placement.gpuUuid,
            );

            assigned.push(
              leasedJob,
            );

            await transaction
              .appendEvent(
                "job.leased",
                leasedJob.id,
                {
                  workerId:
                    placement.workerId,
                  gpuUuid:
                    placement.gpuUuid,
                  attempt:
                    leasedJob.attempt,
                },
                now,
              );

            continue;
          }

          const allocatedSession =
            await transaction
              .assignSession(
                entry.item.id,
                placement,
                leaseId,
                leaseExpiresAt,
                now,
              );

          if (!allocatedSession) {
            continue;
          }

          occupiedGpus.add(
            placement.gpuUuid,
          );

          await transaction
            .appendEvent(
              "session.allocated",
              allocatedSession.id,
              {
                workerId:
                  placement.workerId,
                gpuUuid:
                  placement.gpuUuid,
              },
              now,
            );
        }

        return {
          acquired: true,
          staleWorkerIds,
          recoveredJobs:
            recoveries.map(
              ({ job }) => job,
            ),
          assigned,
        };
      },
    );
  }
}

export function choosePlacement(
  workload,
  workers,
  occupiedGpus,
  {
    now,
    heartbeatTimeoutMs,
    vramSafetyMiB,
    blockedGpuResources = new Set(),
  },
) {
  const requirements =
    workload.constraints ??
    workload.requirements;

  if (!requirements) {
    throw new TypeError(
      "workload must contain constraints or requirements",
    );
  }

  const requiredCapabilities =
    new Set(
      requirements.capabilities,
    );

  const candidates = [];

  for (const worker of workers) {
    if (
      worker.status !== "online" ||
      worker.drainMode ||
      now - worker.lastSeenAt >
        heartbeatTimeoutMs
    ) {
      continue;
    }

    const capabilities =
      new Set(
        worker.capabilities,
      );

    if (
      [...requiredCapabilities]
        .some(
          (capability) =>
            !capabilities.has(
              capability,
            ),
        )
    ) {
      continue;
    }

    if (requirements.adapter != null) {
      const manifests = Array.isArray(worker.adapterManifests)
        ? worker.adapterManifests
        : [];

      const matchingManifests = manifests.filter(
        (manifest) =>
          manifest?.schemaVersion === 2 &&
          manifest.adapterId === requirements.adapter &&
          manifest.executionMode === "streaming-gateway" &&
          requiredCapabilities.has(manifest.type) &&
          (
            workload.capability == null ||
            manifest.type === workload.capability
          ),
      );

      // Ambiguous or absent implementation identity fails closed.
      if (matchingManifests.length !== 1) {
        continue;
      }

      const matched = matchingManifests[0];

      const reports = Array.isArray(worker.adapterHealth)
        ? worker.adapterHealth
        : [];

      const matchingHealth = reports.filter(
        (health) =>
          health?.schemaVersion === 2 &&
          health.adapterId === matched.adapterId &&
          health.type === matched.type,
      );

      // Exactly one report must confirm readiness.
      if (
        matchingHealth.length !== 1 ||
        matchingHealth[0].state !== "ready" ||
        matchingHealth[0].code !== "ready"
      ) {
        continue;
      }
    }

    for (const gpu of worker.gpus) {
      if (
        occupiedGpus.has(
          gpu.uuid,
        ) ||
        blockedGpuResources.has(
          resourceKey(worker.id, gpu.uuid),
        )
      ) {
        continue;
      }

      const freeVramMiB =
        gpu.memoryTotalMiB -
        gpu.memoryUsedMiB -
        vramSafetyMiB;

      if (
        freeVramMiB <
        requirements.minVramMiB
      ) {
        continue;
      }

      const warmModel =
        requirements.model !== null &&
        worker.warmModels.includes(
          requirements.model,
        );

      const cachedModel =
        requirements.model !== null &&
        (
          worker.modelInventory ??
          []
        ).some(
          (entry) =>
            entry.modelId ===
              requirements.model &&
              requiredCapabilities.has(entry.adapterType),
        );

      candidates.push({
        workerId: worker.id,
        gpuUuid: gpu.uuid,
        warmModel,
        cachedModel,
        utilizationPercent:
          gpu.utilizationPercent,
        headroomMiB:
          freeVramMiB -
          requirements.minVramMiB,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      Number(right.warmModel) -
        Number(left.warmModel) ||
      Number(right.cachedModel) -
        Number(left.cachedModel) ||
      left.utilizationPercent -
        right.utilizationPercent ||
      left.headroomMiB -
        right.headroomMiB ||
      left.workerId.localeCompare(
        right.workerId,
      ) ||
      left.gpuUuid.localeCompare(
        right.gpuUuid,
      ),
  );

  return candidates[0] ?? null;
}

// Exact host/device pair, not the GPU UUID alone (UUIDs can repeat
// across test workers and future vendor namespaces).
function resourceKey(workerId, gpuUuid) {
  if (typeof workerId !== "string" || !workerId ||
      typeof gpuUuid !== "string" || !gpuUuid) {
    throw new TypeError("invalid persistent GPU resource identity");
  }
  return JSON.stringify([workerId, gpuUuid]);
}

function comparePendingWork(
  left,
  right,
) {
  return (
    right.item.priority -
      left.item.priority ||
    left.item.createdAt -
      right.item.createdAt ||
    left.item.id.localeCompare(
      right.item.id,
    ) ||
    left.kind.localeCompare(
      right.kind,
    )
  );
}
