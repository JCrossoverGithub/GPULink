/**
 * GPULink DP3C3B2C1: source-backed lease observation, NOT launch authority.
 *
 * Queries the existing persistence contract in one read transaction, rather
 * than accepting a worker/broker-supplied lease snapshot. No token, reservation,
 * GPU device mapping, runtime command, or launch permission is issued.
 *
 * A read transaction cannot fence changes after commit. In particular this
 * does NOT implement B2A/B2B leaseGeneration or reservationId semantics;
 * those values do not yet exist in GPULink's persisted session schema.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FIELDS = ['sessionId', 'leaseId', 'workerId', 'gpuUuid'];
const STATE = new Set(['allocated', 'connecting', 'active']);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
  Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => Object.hasOwn(d,'value'));
const isExact = (v, keys) => isRecord(v) &&
  Object.keys(v).sort().join('\0') === [...keys].sort().join('\0');
const isId = v => typeof v === 'string' && ID.test(v);
const isTime = v => Number.isSafeInteger(v) && v > 0;

export class BrokerAuthorityObservationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BrokerAuthorityObservationError';
    this.code = code;
  }
}
const deny = code => { throw new BrokerAuthorityObservationError(code); };

export async function observeAuthoritativeSessionLease({persistence, expected, nowMs,
  maxWorkerAgeMs=30000} = {}) {
  if (!isExact(expected, FIELDS) || !FIELDS.every(field => isId(expected[field]))) {
    deny('broker_invalid_authority_query');
  }
  if (!isTime(nowMs) || !Number.isSafeInteger(maxWorkerAgeMs) ||
      maxWorkerAgeMs < 1 || maxWorkerAgeMs > 300000) {
    deny('broker_invalid_authority_clock');
  }
  if (!persistence || typeof persistence.transaction !== 'function') {
    deny('broker_authority_unavailable');
  }

  try {
    // For SQLite this uses its BEGIN IMMEDIATE transaction, while Postgres
    // uses its existing persistence transaction API. Neither operation is a
    // durable GPU reservation or authorization to start a workload.
    return await persistence.transaction(async tx => {
      for (const method of ['getSession','getWorker','listOccupyingSessions','listActiveJobs']) {
        if (!tx || typeof tx[method] !== 'function') deny('broker_authority_unavailable');
      }
      const session = await tx.getSession(expected.sessionId);
      if (!isRecord(session) || !STATE.has(session.status) ||
          session.id !== expected.sessionId ||
          session.leaseId !== expected.leaseId ||
          session.assignedWorkerId !== expected.workerId ||
          session.assignedGpuUuid !== expected.gpuUuid ||
          !isTime(session.leaseExpiresAt) || session.leaseExpiresAt <= nowMs) {
        deny('broker_authoritative_lease_not_current');
      }

      const worker = await tx.getWorker(expected.workerId);
      if (!isRecord(worker) || worker.id !== expected.workerId ||
          worker.status !== 'online' || worker.drainMode !== false ||
          !isTime(worker.lastSeenAt) || worker.lastSeenAt < nowMs - maxWorkerAgeMs ||
          worker.lastSeenAt > nowMs + 5000) {
        deny('broker_authoritative_worker_unavailable');
      }
      if (!Array.isArray(worker.gpus) || worker.gpus.length > 256 ||
          worker.gpus.filter(gpu => isRecord(gpu) && gpu.uuid === expected.gpuUuid).length !== 1) {
        deny('broker_authoritative_gpu_missing');
      }

      const sessions = await tx.listOccupyingSessions();
      const jobs = await tx.listActiveJobs();
      if (!Array.isArray(sessions) || !Array.isArray(jobs) ||
          sessions.length > 100000 || jobs.length > 100000) {
        deny('broker_authority_unavailable');
      }
      const matching = sessions.filter(s => isRecord(s) &&
        s.assignedWorkerId === expected.workerId && s.assignedGpuUuid === expected.gpuUuid);
      if (matching.length !== 1 || matching[0].id !== expected.sessionId ||
          jobs.some(job => isRecord(job) && job.assignedWorkerId === expected.workerId &&
            job.assignedGpuUuid === expected.gpuUuid)) {
        deny('broker_authoritative_gpu_conflict');
      }

      return Object.freeze({
        schemaVersion: 1,
        status: 'observed-current-not-fenced',
        sessionId: expected.sessionId,
        leaseId: expected.leaseId,
        workerId: expected.workerId,
        gpuUuid: expected.gpuUuid,
        sessionStatus: session.status,
        leaseExpiresAtMs: session.leaseExpiresAt,
        generationVerified: false,
        attemptReservationVerified: false,
        canLaunch: false,
        observationOnly: true,
      });
    });
  } catch (error) {
    if (error instanceof BrokerAuthorityObservationError) throw error;
    deny('broker_authority_unavailable');
  }
}
