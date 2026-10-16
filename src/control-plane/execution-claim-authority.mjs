// DP3C3B2C2B2B — Internal, non-executing persisted attempt claim.
// This is deliberately NOT an HTTP or broker admission interface.
// No credential supplied here is a launch token; every result denies launch.
const REQUIRED = Object.freeze([
  "subjectKind", "subjectId", "leaseId", "workerId", "gpuUuid",
  "attemptId", "artifactDigest", "adapterIdentity",
  "runtimePolicyRevision", "approvalRef", "now", "maxHeartbeatAgeMs",
]);

export class ExecutionClaimDenied extends Error {
  constructor(code = "execution_claim_denied") {
    super(code);
    this.name = "ExecutionClaimDenied";
    this.code = code;
  }
}

export function validateExecutionClaim(input) {
  if (input === null || typeof input !== "object" ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null)) {
    throw new ExecutionClaimDenied("invalid_claim");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).length !== REQUIRED.length ||
      REQUIRED.some((k) => !Object.hasOwn(descriptors, k) ||
        !Object.hasOwn(descriptors[k], "value"))) {
    throw new ExecutionClaimDenied("invalid_claim");
  }
  const own = Object.fromEntries(REQUIRED.map((k) => [k, descriptors[k].value]));
  if (own.subjectKind !== "job" && own.subjectKind !== "session") {
    throw new ExecutionClaimDenied("invalid_claim");
  }
  for (const name of ["subjectId", "leaseId", "workerId", "gpuUuid", "attemptId",
    "adapterIdentity", "runtimePolicyRevision", "approvalRef"]) {
    if (typeof own[name] !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(own[name])) {
      throw new ExecutionClaimDenied("invalid_claim");
    }
  }
  if (typeof own.artifactDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(own.artifactDigest)) {
    throw new ExecutionClaimDenied("invalid_claim");
  }
  if (!Number.isSafeInteger(own.now) || own.now < 1 ||
      !Number.isSafeInteger(own.maxHeartbeatAgeMs) ||
      own.maxHeartbeatAgeMs < 1 || own.maxHeartbeatAgeMs > 300_000) {
    throw new ExecutionClaimDenied("invalid_claim");
  }
  return Object.freeze(own);
}

export function validateCurrentExecutionOwner(input, worker, workload) {
  if (!worker || worker.status !== "online" || worker.drainMode ||
      !Number.isSafeInteger(worker.lastSeenAt) ||
      worker.lastSeenAt > input.now ||
      input.now - worker.lastSeenAt >= input.maxHeartbeatAgeMs ||
      !Array.isArray(worker.gpus) ||
      !worker.gpus.some((gpu) => gpu && gpu.uuid === input.gpuUuid)) {
    throw new ExecutionClaimDenied("worker_unavailable");
  }
  const allowedStatuses = input.subjectKind === "session"
    ? ["allocated", "connecting", "active"] : ["leased", "running"];
  if (!workload || !allowedStatuses.includes(workload.status) ||
      workload.leaseId !== input.leaseId ||
      workload.assignedWorkerId !== input.workerId ||
      workload.assignedGpuUuid !== input.gpuUuid ||
      !Number.isSafeInteger(workload.leaseExpiresAt) ||
      workload.leaseExpiresAt <= input.now) {
    throw new ExecutionClaimDenied("stale_lease");
  }
}

// IMPORTANT: all persistence writes must occur within a transaction that
// holds the shared allocation lock; PostgreSQL acquires it inside the writer.
// SQLite acquires BEGIN IMMEDIATE at its persistence transaction boundary.
export async function reservePersistedExecutionAttempt(persistence, rawInput) {
  const input = validateExecutionClaim(rawInput);
  if (!persistence || typeof persistence.transaction !== "function") {
    throw new ExecutionClaimDenied("authority_unavailable");
  }
  return persistence.transaction(async (transaction) => {
    if (!transaction || typeof transaction.reserveExecutionAttempt !== "function") {
      throw new ExecutionClaimDenied("authority_unavailable");
    }
    const result = await transaction.reserveExecutionAttempt(input);
    if (!result || result.canLaunch !== false ||
        result.attemptId !== input.attemptId ||
        !Number.isSafeInteger(result.fenceEpoch) || result.fenceEpoch < 1) {
      throw new ExecutionClaimDenied("authority_unavailable");
    }
    return Object.freeze({...result, canLaunch: false});
  });
}
