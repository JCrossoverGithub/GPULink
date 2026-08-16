import { createId } from "../shared/ids.mjs";

export class Scheduler {
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
    return this.database.transaction(() => {
      const now = this.clock();
      const staleWorkerIds = this.database.markStaleWorkersOffline(
        now - this.heartbeatTimeoutMs,
        now,
      );
      for (const workerId of staleWorkerIds) {
        this.database.appendEvent("worker.offline", workerId, { reason: "heartbeat_timeout" }, now);
      }

      const recoveredJobs = this.database.recoverExpiredJobs(now, staleWorkerIds);
      for (const job of recoveredJobs) {
        this.database.appendEvent(
          job.status === "queued" ? "job.requeued" : "job.failed",
          job.id,
          { reason: "lease_expired", attempt: job.attempt },
          now,
        );
      }

      const workers = this.database.listWorkers();
      const activeJobs = this.database.listActiveJobs();
      const occupiedGpus = new Set(activeJobs.map((job) => job.assignedGpuUuid).filter(Boolean));
      const assigned = [];

      for (const job of this.database.listQueuedJobs()) {
        const placement = choosePlacement(job, workers, occupiedGpus, {
          now,
          heartbeatTimeoutMs: this.heartbeatTimeoutMs,
          vramSafetyMiB: this.vramSafetyMiB,
        });
        if (!placement) continue;

        const leaseId = createId("lease");
        const leasedJob = this.database.assignJob(
          job.id,
          placement,
          leaseId,
          now + this.leaseDurationMs,
          now,
        );
        if (!leasedJob) continue;

        occupiedGpus.add(placement.gpuUuid);
        assigned.push(leasedJob);
        this.database.appendEvent("job.leased", leasedJob.id, {
          workerId: placement.workerId,
          gpuUuid: placement.gpuUuid,
          attempt: leasedJob.attempt,
        }, now);
      }

      return { staleWorkerIds, recoveredJobs, assigned };
    });
  }
}

export function choosePlacement(job, workers, occupiedGpus, {
  now,
  heartbeatTimeoutMs,
  vramSafetyMiB,
}) {
  const requiredCapabilities = new Set(job.constraints.capabilities);
  const candidates = [];

  for (const worker of workers) {
    if (
      worker.status !== "online" ||
      worker.drainMode ||
      now - worker.lastSeenAt > heartbeatTimeoutMs
    ) continue;

    const capabilities = new Set(worker.capabilities);
    if ([...requiredCapabilities].some((capability) => !capabilities.has(capability))) {
      continue;
    }

    for (const gpu of worker.gpus) {
      if (occupiedGpus.has(gpu.uuid)) continue;
      const freeVramMiB = gpu.memoryTotalMiB - gpu.memoryUsedMiB - vramSafetyMiB;
      if (freeVramMiB < job.constraints.minVramMiB) continue;

      const warmModel = job.constraints.model !== null &&
        worker.warmModels.includes(job.constraints.model);
      candidates.push({
        workerId: worker.id,
        gpuUuid: gpu.uuid,
        warmModel,
        utilizationPercent: gpu.utilizationPercent,
        headroomMiB: freeVramMiB - job.constraints.minVramMiB,
      });
    }
  }

  candidates.sort((left, right) =>
    Number(right.warmModel) - Number(left.warmModel) ||
    left.utilizationPercent - right.utilizationPercent ||
    left.headroomMiB - right.headroomMiB ||
    left.workerId.localeCompare(right.workerId) ||
    left.gpuUuid.localeCompare(right.gpuUuid));

  return candidates[0] ?? null;
}
