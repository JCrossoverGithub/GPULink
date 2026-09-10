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
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.leaseDurationMs = leaseDurationMs;
    this.vramSafetyMiB = vramSafetyMiB;
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
    return this.database.transaction(async (transaction) => {
      const now = this.clock();

      const staleWorkerIds =
        await transaction.markStaleWorkersOffline(
          now - this.heartbeatTimeoutMs,
          now,
        );

      for (const workerId of staleWorkerIds) {
        await transaction.appendEvent(
          "worker.offline",
          workerId,
          { reason: "heartbeat_timeout" },
          now,
        );
      }

      const recoveries =
        await transaction.recoverExpiredJobs(
          now,
          staleWorkerIds,
        );

      for (const { job, reason } of recoveries) {
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

      const workers =
        await transaction.listWorkers();

      const activeJobs =
        await transaction.listActiveJobs();

      const occupiedGpus = new Set(
        activeJobs
          .map((job) => job.assignedGpuUuid)
          .filter(Boolean),
      );

      const assigned = [];

      const queuedJobs =
        await transaction.listQueuedJobs();

      for (const job of queuedJobs) {
        const placement = choosePlacement(
          job,
          workers,
          occupiedGpus,
          {
            now,
            heartbeatTimeoutMs:
              this.heartbeatTimeoutMs,
            vramSafetyMiB:
              this.vramSafetyMiB,
          },
        );

        if (!placement) continue;

        const leaseId = createId("lease");

        const leasedJob =
          await transaction.assignJob(
            job.id,
            placement,
            leaseId,
            now + this.leaseDurationMs,
            now,
          );

        if (!leasedJob) continue;

        occupiedGpus.add(placement.gpuUuid);
        assigned.push(leasedJob);

        await transaction.appendEvent(
          "job.leased",
          leasedJob.id,
          {
            workerId: placement.workerId,
            gpuUuid: placement.gpuUuid,
            attempt: leasedJob.attempt,
          },
          now,
        );
      }

      return {
        staleWorkerIds,
        recoveredJobs:
          recoveries.map(({ job }) => job),
        assigned,
      };
    });
  }
}

export function choosePlacement(job, workers, occupiedGpus, {
  now,
  heartbeatTimeoutMs,
  vramSafetyMiB,
}) {
  const requiredCapabilities =
    new Set(job.constraints.capabilities);

  const candidates = [];

  for (const worker of workers) {
    if (
      worker.status !== "online" ||
      worker.drainMode ||
      now - worker.lastSeenAt > heartbeatTimeoutMs
    ) {
      continue;
    }

    const capabilities =
      new Set(worker.capabilities);

    if (
      [...requiredCapabilities]
        .some(
          (capability) =>
            !capabilities.has(capability),
        )
    ) {
      continue;
    }

    for (const gpu of worker.gpus) {
      if (occupiedGpus.has(gpu.uuid)) continue;

      const freeVramMiB =
        gpu.memoryTotalMiB -
        gpu.memoryUsedMiB -
        vramSafetyMiB;

      if (
        freeVramMiB <
        job.constraints.minVramMiB
      ) {
        continue;
      }

      const warmModel =
        job.constraints.model !== null &&
        worker.warmModels.includes(
          job.constraints.model,
        );

      const cachedModel =
        job.constraints.model !== null &&
        (worker.modelInventory ?? [])
          .some(
            (entry) =>
              entry.modelId ===
              job.constraints.model,
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
          job.constraints.minVramMiB,
      });
    }
  }

  candidates.sort((left, right) =>
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
    ));

  return candidates[0] ?? null;
}
