import { timingSafeEqual } from "node:crypto";
import { createId } from "../shared/ids.mjs";
import { validateAdapterHealth } from "../shared/adapter-health.mjs";
import { validateAdapterManifests } from "../shared/adapter-manifest.mjs";
import { validateModelInventory } from "../shared/model-inventory.mjs";
import { validateWorkloadPayload } from "../shared/workload-contracts.mjs";
import { validateSessionRequest } from "../shared/session-contract.mjs";
import {
  DATA_PLANE_GRANT_AUDIENCE,
  DATA_PLANE_GRANT_SCHEMA_VERSION,
  signDataPlaneGrant,
  validateDataPlaneGrantClaims,
  verifyDataPlaneGrant,
} from "../shared/data-plane-grant.mjs";
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

    const supplied = Buffer.from(
      authorization.slice(7),
      "utf8",
    );

    return [...new Set([...allowedScopes, "admin"])]
      .some((scope) => {
        const token = this.config.tokens[scope];
        if (!token) return false;

        const expected = Buffer.from(
          token,
          "utf8",
        );

        return supplied.length === expected.length &&
          timingSafeEqual(supplied, expected);
      });
  }

  async registerWorker(input) {
    const worker =
      validateWorker(input, this.clock());

    const stored =
      await this.database.transaction(
        async (transaction) => {
          const result =
            await transaction.upsertWorker(
              worker,
            );

          await transaction.appendEvent(
            "worker.online",
            result.id,
            {
              name: result.name,
              gpuCount: result.gpus.length,
            },
            worker.now,
          );

          return result;
        },
      );

    await this.scheduler.runOnce();

    return stored;
  }

  async heartbeatWorker(workerId, input) {
    const heartbeat =
      validateHeartbeat(input, this.clock());

    const worker =
      await this.database
        .updateWorkerHeartbeat(
          workerId,
          heartbeat,
        );

    if (!worker) {
      throw new NotFoundError(
        "worker not found",
      );
    }

    await this.scheduler.runOnce();

    return worker;
  }

  async setWorkerDrain(workerId, input) {
    const object =
      requireObject(input, "request");

    if (typeof object.drain !== "boolean") {
      throw new ValidationError(
        "drain must be a boolean",
      );
    }

    const now = this.clock();

    return this.database.transaction(
      async (transaction) => {
        const worker =
          await transaction.setWorkerDrain(
            workerId,
            object.drain,
            now,
          );

        if (!worker) {
          throw new NotFoundError(
            "worker not found",
          );
        }

        await transaction.appendEvent(
          object.drain
            ? "worker.draining"
            : "worker.resumed",
          worker.id,
          {},
          now,
        );

        return worker;
      },
    );
  }

  async submitJob(
    input,
    idempotencyHeader = null,
  ) {
    const job = validateJob(
      input,
      idempotencyHeader,
      this.clock(),
    );

    const inserted =
      await this.database.transaction(
        async (transaction) => {
          const result =
            await transaction.insertJob(job);

          if (!result.duplicate) {
            await transaction.appendEvent(
              "job.queued",
              result.job.id,
              {
                projectId:
                  result.job.projectId,
                type: result.job.type,
                priority:
                  result.job.priority,
              },
              job.now,
            );
          }

          return result;
        },
      );

    await this.scheduler.runOnce();

    const storedJob =
      await this.database.getJob(
        inserted.job.id,
      );

    return {
      ...inserted,
      job: storedJob,
    };
  }

  async submitSession(
    input,
    idempotencyHeader = null,
  ) {
    const request =
      validateSessionRequest(input);

    const now = this.clock();

    const session = {
      id: createId("session"),
      ...request,
      idempotencyKey:
        optionalString(
          idempotencyHeader,
          "idempotencyKey",
          null,
          { maximum: 200 },
        ),
      now,
    };

    const inserted =
      await this.database.transaction(
        async (transaction) => {
          const result =
            await transaction
              .insertSession(session);

          if (!result.duplicate) {
            await transaction.appendEvent(
              "session.requested",
              result.session.id,
              {
                projectId:
                  result.session.projectId,
                capability:
                  result.session.capability,
                priority:
                  result.session.priority,
              },
              now,
            );
          }

          return result;
        },
      );

    await this.scheduler.runOnce();

    const storedSession =
      await this.database.getSession(
        inserted.session.id,
      );

    return {
      ...inserted,
      session: storedSession,
    };
  }

  async issueDataPlaneGrant(
    sessionId,
    role,
    input = null,
  ) {
    if (
      role !== "client" &&
      role !== "worker"
    ) {
      throw new ValidationError(
        "data-plane grant role must be client or worker",
      );
    }

    const now =
      this.clock();

    const session =
      await this.database
        .getSession(
          sessionId,
        );

    if (!session) {
      throw new NotFoundError(
        "session not found",
      );
    }

    if (
      session.status !== "allocated" &&
      session.status !== "connecting" &&
      session.status !== "active"
    ) {
      throw new ConflictError(
        "session does not own an active allocation",
      );
    }

    if (
      !session.assignedWorkerId ||
      !session.leaseId ||
      !Number.isSafeInteger(
        session.leaseExpiresAt,
      ) ||
      session.leaseExpiresAt <= now
    ) {
      throw new ConflictError(
        "session lease is not currently valid",
      );
    }

    if (role === "worker") {
      const lease =
        validateLeaseAction(
          input,
        );

      if (
        lease.workerId !==
          session.assignedWorkerId ||
        lease.leaseId !==
          session.leaseId
      ) {
        throw new ConflictError(
          "session lease is not valid for this worker",
        );
      }
    }

    const configuredTtlMs =
      this.config
        .dataPlaneGrantTtlMs;

    if (
      !Number.isSafeInteger(
        configuredTtlMs,
      ) ||
      configuredTtlMs <= 0
    ) {
      throw new Error(
        "data-plane grant TTL is not configured",
      );
    }

    const expiresAt =
      Math.min(
        now +
          configuredTtlMs,
        session.leaseExpiresAt,
      );

    if (expiresAt <= now) {
      throw new ConflictError(
        "session lease is not currently valid",
      );
    }

    const claims = {
      schemaVersion:
        DATA_PLANE_GRANT_SCHEMA_VERSION,
      audience:
        DATA_PLANE_GRANT_AUDIENCE,
      role,
      sessionId:
        session.id,
      workerId:
        session.assignedWorkerId,
      leaseId:
        session.leaseId,
      issuedAt: now,
      expiresAt,
      nonce:
        createId("grant"),
    };

    return {
      token:
        signDataPlaneGrant(
          claims,
          this.config
            .dataPlaneSigningKey,
        ),
      expiresAt,
    };
  }

  async authorizeDataPlaneGrant(
    token,
    expectedRole,
  ) {
    validateDataPlaneRole(
      expectedRole,
    );

    const now =
      this.clock();

    const claims =
      verifyDataPlaneGrant(
        token,
        this.config
          .dataPlaneSigningKey,
        {
          now,
        },
      );

    if (!claims) {
      return null;
    }

    return this
      .authorizeDataPlaneAllocation(
        claims,
        expectedRole,
      );
  }

  async authorizeDataPlaneAllocation(
    claims,
    expectedRole,
  ) {
    validateDataPlaneRole(
      expectedRole,
    );

    let normalizedClaims;

    try {
      /*
       * Validate schema, audience, role vocabulary,
       * identity fields, and bounded signed lifetime.
       *
       * Deliberately do not check whether expiresAt
       * is before the current wall clock here.
       * Cryptographic expiry is an admission rule;
       * established relay lifetime is governed by
       * current allocation ownership.
       */
      normalizedClaims =
        validateDataPlaneGrantClaims(
          claims,
        );
    } catch {
      return null;
    }

    if (
      normalizedClaims.role !==
        expectedRole
    ) {
      return null;
    }

    const now =
      this.clock();

    const session =
      await this.database
        .getSession(
          normalizedClaims
            .sessionId,
        );

    if (
      !session ||
      (
        session.status !==
          "allocated" &&
        session.status !==
          "connecting" &&
        session.status !==
          "active"
      ) ||
      session.assignedWorkerId !==
        normalizedClaims.workerId ||
      session.leaseId !==
        normalizedClaims.leaseId ||
      !Number.isSafeInteger(
        session.leaseExpiresAt,
      ) ||
      session.leaseExpiresAt <= now
    ) {
      return null;
    }

    return {
      claims:
        normalizedClaims,
      session,
    };
  }

  async startSession(
    sessionId,
    input,
  ) {
    const lease =
      validateLeaseAction(input);

    const now = this.clock();

    return this.database.transaction(
      async (transaction) => {
        const session =
          await transaction
            .startSession(
              sessionId,
              lease.workerId,
              lease.leaseId,
              now +
                this.config
                  .leaseDurationMs,
              now,
            );

        if (!session) {
          throw new ConflictError(
            "session lease is not valid for this worker",
          );
        }

        await transaction.appendEvent(
          "session.connecting",
          session.id,
          {
            workerId:
              lease.workerId,
          },
          now,
        );

        return session;
      },
    );
  }

  async activateSession(
    sessionId,
    input,
  ) {
    const lease =
      validateLeaseAction(input);

    const now = this.clock();

    return this.database.transaction(
      async (transaction) => {
        const session =
          await transaction
            .activateSession(
              sessionId,
              lease.workerId,
              lease.leaseId,
              now +
                this.config
                  .leaseDurationMs,
              now,
            );

        if (!session) {
          throw new ConflictError(
            "connecting session lease is not valid for this worker",
          );
        }

        await transaction.appendEvent(
          "session.active",
          session.id,
          {
            workerId:
              lease.workerId,
          },
          now,
        );

        return session;
      },
    );
  }

  async renewSession(
    sessionId,
    input,
  ) {
    const lease =
      validateLeaseAction(input);

    const now = this.clock();

    const session =
      await this.database
        .renewSession(
          sessionId,
          lease.workerId,
          lease.leaseId,
          now +
            this.config
              .leaseDurationMs,
          now,
        );

    if (!session) {
      throw new ConflictError(
        "session lease is not valid for this worker",
      );
    }

    return session;
  }

  async closeSession(sessionId) {
    const now = this.clock();

    const session =
      await this.database.transaction(
        async (transaction) => {
          const existing =
            await transaction
              .getSession(
                sessionId,
              );

          if (!existing) {
            throw new NotFoundError(
              "session not found",
            );
          }

          const closed =
            await transaction
              .closeSession(
                sessionId,
                now,
              );

          if (!closed) {
            throw new ConflictError(
              `session cannot be closed from ${existing.status}`,
            );
          }

          await transaction.appendEvent(
            "session.closed",
            sessionId,
            {
              previousStatus:
                existing.status,
            },
            now,
          );

          return closed;
        },
      );

    await this.scheduler.runOnce();

    return session;
  }

  async startJob(jobId, input) {
    const lease =
      validateLeaseAction(input);

    const now = this.clock();

    return this.database.transaction(
      async (transaction) => {
        const job =
          await transaction.startJob(
            jobId,
            lease.workerId,
            lease.leaseId,
            now + this.config.leaseDurationMs,
            now,
          );

        if (!job) {
          throw new ConflictError(
            "job lease is not valid for this worker",
          );
        }

        await transaction.appendEvent(
          "job.started",
          job.id,
          {
            workerId: lease.workerId,
            attempt: job.attempt,
          },
          now,
        );

        return job;
      },
    );
  }

  async renewJob(jobId, input) {
    const lease =
      validateLeaseAction(input);

    const now = this.clock();

    return this.database.transaction(
      async (transaction) => {
        const job =
          await transaction.renewJob(
            jobId,
            lease.workerId,
            lease.leaseId,
            now + this.config.leaseDurationMs,
            now,
          );

        if (!job) {
          throw new ConflictError(
            "running job lease is not valid for this worker",
          );
        }

        return job;
      },
    );
  }

  async finishJob(jobId, input) {
    const object =
      requireObject(input, "request");

    const lease =
      validateLeaseAction(object);

    const outcome =
      requireString(
        object.outcome,
        "outcome",
        { maximum: 20 },
      );

    if (
      !new Set(["succeeded", "failed"])
        .has(outcome)
    ) {
      throw new ValidationError(
        "outcome must be succeeded or failed",
      );
    }

    const result =
      object.result === undefined
        ? null
        : object.result;

    const error =
      object.error === undefined
        ? null
        : object.error;

    const now = this.clock();

    const job =
      await this.database.transaction(
        async (transaction) => {
          const stored =
            await transaction.finishJob(
              jobId,
              lease.workerId,
              lease.leaseId,
              outcome,
              result,
              error,
              now,
            );

          if (!stored) {
            throw new ConflictError(
              "job lease is not valid for this worker",
            );
          }

          await transaction.appendEvent(
            `job.${outcome}`,
            stored.id,
            {
              workerId: lease.workerId,
              attempt: stored.attempt,
            },
            now,
          );

          return stored;
        },
      );

    await this.scheduler.runOnce();

    return job;
  }

  async cancelJob(jobId) {
    const now = this.clock();

    const job =
      await this.database.transaction(
        async (transaction) => {
          const existing =
            await transaction.getJob(
              jobId,
            );

          if (!existing) {
            throw new NotFoundError(
              "job not found",
            );
          }

          const cancelled =
            await transaction.cancelJob(
              jobId,
              now,
            );

          if (!cancelled) {
            throw new ConflictError(
              `job is already ${existing.status}`,
            );
          }

          await transaction.appendEvent(
            "job.cancelled",
            jobId,
            {},
            now,
          );

          return cancelled;
        },
      );

    await this.scheduler.runOnce();

    return job;
  }
}

function validateWorker(input, now) {
  const object = requireObject(input, "worker");
  const capabilities = stringArray(object.capabilities ?? [], "capabilities");
  const adapterState = validateAdvertisedAdapterState(object, capabilities);
  return {
    id: optionalString(object.id, "id", createId("worker"), { maximum: 100 }),
    name: requireString(object.name, "name", { maximum: 100 }),
    version: requireString(object.version, "version", { maximum: 50 }),
    baseUrl: optionalString(object.baseUrl, "baseUrl", null, { maximum: 500 }),
    labels: validateLabels(optionalObject(object.labels, "labels")),
    capabilities,
    adapterManifests: adapterState.manifests,
    adapterHealth: adapterState.health,
    warmModels: stringArray(object.warmModels ?? [], "warmModels"),
    modelInventory: validateModelInventory(object.modelInventory ?? []),
    gpus: validateGpus(object.gpus),
    now,
  };
}

function validateHeartbeat(input, now) {
  const object = requireObject(input, "heartbeat");
  const capabilities = stringArray(object.capabilities ?? [], "capabilities");
  const adapterState = validateAdvertisedAdapterState(object, capabilities);
  return {
    capabilities,
    adapterManifests: adapterState.manifests,
    adapterHealth: adapterState.health,
    warmModels: stringArray(object.warmModels ?? [], "warmModels"),
    modelInventory: validateModelInventory(object.modelInventory ?? []),
    gpus: validateGpus(object.gpus),
    now,
  };
}

function validateAdvertisedAdapterState(object, capabilities) {
  const manifests = validateAdapterManifests(
    object.adapterManifests ?? [],
  );
  const health = validateAdapterHealth(
    object.adapterHealth ?? [],
  );

  for (const manifest of manifests) {
    if (!capabilities.includes(manifest.type)) {
      throw new ValidationError(
        `adapter manifest ${manifest.type} must match an advertised capability`,
      );
    }
  }

  // Preserve legacy v1 workers without health reports.
  // V2 implementations require explicit identity-aware health.
  if (health.length === 0) {
    if (manifests.some((entry) => entry.schemaVersion === 2)) {
      throw new ValidationError(
        "v2 adapter manifests require adapter health reports",
      );
    }
    return { manifests, health };
  }

  const identityOf = (entry) =>
    JSON.stringify([
      entry.schemaVersion,
      entry.type,
      entry.adapterId ?? null,
    ]);

  const readyReports = health.filter(
    (report) => report.state === "ready",
  );

  const manifestIdentities = new Set(
    manifests.map(identityOf),
  );

  const readyIdentities = new Set(
    readyReports.map(identityOf),
  );

  const readyTypes = new Set(
    readyReports.map((report) => report.type),
  );

  if (
    !sameStringSet(manifestIdentities, readyIdentities) ||
    !sameStringSet(new Set(capabilities), readyTypes)
  ) {
    const usesV2Identity = manifests.some(
      (entry) => entry.schemaVersion === 2,
    ) || health.some(
      (entry) => entry.schemaVersion === 2,
    );

    throw new ValidationError(
      usesV2Identity
        ? "ready adapter manifests, health, and advertised capabilities must match by identity"
        : "ready adapter health, manifests, and advertised capabilities must match",
    );
  }

  return { manifests, health };
}

function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

function validateDataPlaneRole(
  role,
) {
  if (
    role !== "client" &&
    role !== "worker"
  ) {
    throw new TypeError(
      "expected data-plane role must be client or worker",
    );
  }

  return role;
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
