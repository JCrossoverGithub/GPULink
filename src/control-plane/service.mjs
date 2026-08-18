import { timingSafeEqual } from "node:crypto";
import { createId } from "../shared/ids.mjs";
import { validateWorkloadPayload } from "../shared/benchmark-contract.mjs";
import {
  boundedInteger,
  optionalObject,
  optionalString,
  requireObject,
  requireString,
  stringArray,
  ValidationError,
} from "../shared/validation.mjs";

export class ControlPlaneService {
  constructor(database, scheduler, config, { clock = () => Date.now() } = {}) {
    this.database = database;
    this.scheduler = scheduler;
    this.config = config;
    this.clock = clock;
  }

  authenticate(authorization, allowedScopes) {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return false;
    }
    const supplied = Buffer.from(authorization.slice(7), "utf8");
    return [...new Set([...allowedScopes, "admin"])].some((scope) => {
      const token = this.config.tokens[scope];
      if (!token) return false;
      const expected = Buffer.from(token, "utf8");
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
  }

  registerWorker(input) {
    const worker = validateWorker(input, this.clock());
    const stored = this.database.transaction(() => {
      const result = this.database.upsertWorker(worker);
      this.database.appendEvent("worker.online", result.id, {
        name: result.name,
        gpuCount: result.gpus.length,
      }, worker.now);
      return result;
    });
    this.scheduler.runOnce();
    return stored;
  }

  heartbeatWorker(workerId, input) {
    const heartbeat = validateHeartbeat(input, this.clock());
    const worker = this.database.updateWorkerHeartbeat(workerId, heartbeat);
    if (!worker) throw new NotFoundError("worker not found");
    this.scheduler.runOnce();
    return worker;
  }

  setWorkerDrain(workerId, input) {
    const object = requireObject(input, "request");
    if (typeof object.drain !== "boolean") {
      throw new ValidationError("drain must be a boolean");
    }
    const now = this.clock();
    return this.database.transaction(() => {
      const worker = this.database.setWorkerDrain(workerId, object.drain, now);
      if (!worker) throw new NotFoundError("worker not found");
      this.database.appendEvent(
        object.drain ? "worker.draining" : "worker.resumed",
        worker.id,
        {},
        now,
      );
      return worker;
    });
  }

  submitJob(input, idempotencyHeader = null) {
    const job = validateJob(input, idempotencyHeader, this.clock());
    const inserted = this.database.transaction(() => {
      const result = this.database.insertJob(job);
      if (!result.duplicate) {
        this.database.appendEvent("job.queued", result.job.id, {
          projectId: result.job.projectId,
          type: result.job.type,
          priority: result.job.priority,
        }, job.now);
      }
      return result;
    });
    this.scheduler.runOnce();
    return { ...inserted, job: this.database.getJob(inserted.job.id) };
  }

  startJob(jobId, input) {
    const lease = validateLeaseAction(input);
    const now = this.clock();
    return this.database.transaction(() => {
      const job = this.database.startJob(
        jobId,
        lease.workerId,
        lease.leaseId,
        now + this.config.leaseDurationMs,
        now,
      );
      if (!job) throw new ConflictError("job lease is not valid for this worker");
      this.database.appendEvent("job.started", job.id, {
        workerId: lease.workerId,
        attempt: job.attempt,
      }, now);
      return job;
    });
  }

  renewJob(jobId, input) {
    const lease = validateLeaseAction(input);
    const now = this.clock();
    return this.database.transaction(() => {
      const job = this.database.renewJob(
        jobId,
        lease.workerId,
        lease.leaseId,
        now + this.config.leaseDurationMs,
        now,
      );
      if (!job) throw new ConflictError("running job lease is not valid for this worker");
      return job;
    });
  }

  finishJob(jobId, input) {
    const object = requireObject(input, "request");
    const lease = validateLeaseAction(object);
    const outcome = requireString(object.outcome, "outcome", { maximum: 20 });
    if (!new Set(["succeeded", "failed"]).has(outcome)) {
      throw new ValidationError("outcome must be succeeded or failed");
    }
    const result = object.result === undefined ? null : object.result;
    const error = object.error === undefined ? null : object.error;
    const now = this.clock();
    const job = this.database.transaction(() => {
      const stored = this.database.finishJob(
        jobId,
        lease.workerId,
        lease.leaseId,
        outcome,
        result,
        error,
        now,
      );
      if (!stored) throw new ConflictError("job lease is not valid for this worker");
      this.database.appendEvent(`job.${outcome}`, stored.id, {
        workerId: lease.workerId,
        attempt: stored.attempt,
      }, now);
      return stored;
    });
    this.scheduler.runOnce();
    return job;
  }

  cancelJob(jobId) {
    const now = this.clock();
    const job = this.database.transaction(() => {
      const existing = this.database.getJob(jobId);
      if (!existing) throw new NotFoundError("job not found");
      const cancelled = this.database.cancelJob(jobId, now);
      if (!cancelled) throw new ConflictError(`job is already ${existing.status}`);
      this.database.appendEvent("job.cancelled", jobId, {}, now);
      return cancelled;
    });
    this.scheduler.runOnce();
    return job;
  }
}

function validateWorker(input, now) {
  const object = requireObject(input, "worker");
  return {
    id: optionalString(object.id, "id", createId("worker"), { maximum: 100 }),
    name: requireString(object.name, "name", { maximum: 100 }),
    version: requireString(object.version, "version", { maximum: 50 }),
    baseUrl: optionalString(object.baseUrl, "baseUrl", null, { maximum: 500 }),
    labels: validateLabels(optionalObject(object.labels, "labels")),
    capabilities: stringArray(object.capabilities ?? [], "capabilities"),
    warmModels: stringArray(object.warmModels ?? [], "warmModels"),
    gpus: validateGpus(object.gpus),
    now,
  };
}

function validateHeartbeat(input, now) {
  const object = requireObject(input, "heartbeat");
  return {
    capabilities: stringArray(object.capabilities ?? [], "capabilities"),
    warmModels: stringArray(object.warmModels ?? [], "warmModels"),
    gpus: validateGpus(object.gpus),
    now,
  };
}

function validateLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length > 64) throw new ValidationError("labels may contain at most 64 entries");
  return Object.fromEntries(entries.map(([key, value]) => [
    requireString(key, "label key", { maximum: 100 }),
    requireString(value, `label ${key}`, { maximum: 200 }),
  ]));
}

function validateGpus(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new ValidationError("gpus must be an array containing at most 16 GPUs");
  }
  const uuids = new Set();
  return value.map((gpu, index) => {
    const object = requireObject(gpu, `gpus[${index}]`);
    const uuid = requireString(object.uuid, `gpus[${index}].uuid`, { maximum: 100 });
    if (uuids.has(uuid)) throw new ValidationError(`duplicate GPU UUID ${uuid}`);
    uuids.add(uuid);
    return {
      uuid,
      index: boundedInteger(object.index, `gpus[${index}].index`, { maximum: 128 }),
      name: requireString(object.name, `gpus[${index}].name`, { maximum: 200 }),
      memoryTotalMiB: boundedInteger(object.memoryTotalMiB, `gpus[${index}].memoryTotalMiB`, { minimum: 1 }),
      memoryUsedMiB: boundedInteger(object.memoryUsedMiB, `gpus[${index}].memoryUsedMiB`),
      utilizationPercent: boundedInteger(object.utilizationPercent, `gpus[${index}].utilizationPercent`, { maximum: 100 }),
      temperatureC: boundedInteger(object.temperatureC, `gpus[${index}].temperatureC`, { maximum: 200 }),
      powerDrawWatts: Number.isFinite(object.powerDrawWatts) ? object.powerDrawWatts : null,
    };
  });
}

function validateJob(input, idempotencyHeader, now) {
  const object = requireObject(input, "job");
  const constraints = optionalObject(object.constraints, "constraints");
  const type = requireString(object.type, "type", { maximum: 100 });
  const gpuCount = boundedInteger(constraints.gpuCount, "constraints.gpuCount", {
    minimum: 1,
    maximum: 1,
    fallback: 1,
  });
  return {
    id: createId("job"),
    projectId: requireString(object.projectId, "projectId", { maximum: 100 }),
    type,
    priority: boundedInteger(object.priority, "priority", {
      minimum: -1000,
      maximum: 1000,
      fallback: 0,
    }),
    gpuCount,
    minVramMiB: boundedInteger(constraints.minVramMiB, "constraints.minVramMiB", {
      minimum: 1,
      maximum: 1_000_000,
      fallback: 1,
    }),
    requiredCapabilities: stringArray(
      constraints.capabilities ?? [object.type],
      "constraints.capabilities",
    ),
    requestedModel: optionalString(constraints.model, "constraints.model", null, { maximum: 300 }),
    payload: validateWorkloadPayload(type, optionalObject(object.payload, "payload")),
    maxAttempts: boundedInteger(object.maxAttempts, "maxAttempts", {
      minimum: 1,
      maximum: 20,
      fallback: 3,
    }),
    idempotencyKey: optionalString(
      idempotencyHeader ?? object.idempotencyKey,
      "idempotencyKey",
      null,
      { maximum: 200 },
    ),
    now,
  };
}

function validateLeaseAction(input) {
  const object = requireObject(input, "request");
  return {
    workerId: requireString(object.workerId, "workerId", { maximum: 100 }),
    leaseId: requireString(object.leaseId, "leaseId", { maximum: 100 }),
  };
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
  }
}
