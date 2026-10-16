import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJson, stringifyJson } from "../shared/json.mjs";
import { validateExecutionClaim, validateCurrentExecutionOwner, ExecutionClaimDenied } from "./execution-claim-authority.mjs";

const ACTIVE_JOB_STATES = Object.freeze(["leased", "running"]);

export class ControlPlaneDatabase {
  constructor(filename = ":memory:") {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#migrate();
  }

  close() {
    this.database.close();
  }

  transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        base_url TEXT,
        status TEXT NOT NULL CHECK(status IN ('online', 'offline')),
        drain_mode INTEGER NOT NULL DEFAULT 0 CHECK(drain_mode IN (0, 1)),
        labels_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        adapter_manifests_json TEXT NOT NULL DEFAULT '[]',
        adapter_health_json TEXT NOT NULL DEFAULT '[]',
        warm_models_json TEXT NOT NULL,
        model_inventory_json TEXT NOT NULL DEFAULT '[]',
        gpu_inventory_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
        gpu_count INTEGER NOT NULL CHECK(gpu_count = 1),
        min_vram_mib INTEGER NOT NULL,
        required_capabilities_json TEXT NOT NULL,
        requested_model TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        assigned_worker_id TEXT REFERENCES workers(id),
        assigned_gpu_uuid TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS jobs_queue_index
        ON jobs(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS jobs_worker_index
        ON jobs(assigned_worker_id, status);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        project_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'requested',
          'allocated',
          'connecting',
          'active',
          'interrupted',
          'closed'
        )),
        gpu_count INTEGER NOT NULL CHECK(gpu_count = 1),
        min_vram_mib INTEGER NOT NULL CHECK(min_vram_mib >= 0),
        required_capabilities_json TEXT NOT NULL,
        requested_model TEXT,
        requested_adapter TEXT,
        metadata_json TEXT NOT NULL,
        max_interruptions INTEGER NOT NULL
          CHECK(max_interruptions >= 0 AND max_interruptions <= 3),
        interruption_count INTEGER NOT NULL DEFAULT 0
          CHECK(interruption_count >= 0),
        assigned_worker_id TEXT REFERENCES workers(id),
        assigned_gpu_uuid TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS sessions_queue_index
        ON sessions(
          status,
          priority DESC,
          created_at ASC,
          id ASC
        );

      CREATE INDEX IF NOT EXISTS sessions_worker_index
        ON sessions(
          assigned_worker_id,
          status
        );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        subject_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- B2C2B1: inert storage. Do not infer physical safety or launch permission.
      CREATE TABLE IF NOT EXISTS gpu_resource_fences (
        worker_id TEXT NOT NULL REFERENCES workers(id),
        gpu_uuid TEXT NOT NULL CHECK(length(gpu_uuid) > 0),
        epoch INTEGER NOT NULL CHECK(epoch >= 1),
        safety_state TEXT NOT NULL CHECK(safety_state IN
          ('clear','allocated','reserved','running','cleanup_required','quarantined')),
        subject_kind TEXT CHECK(subject_kind IN ('session','job')),
        subject_id TEXT,
        lease_id TEXT,
        attempt_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (worker_id, gpu_uuid),
        CHECK (
          (safety_state = 'clear' AND subject_kind IS NULL AND
           subject_id IS NULL AND lease_id IS NULL AND attempt_id IS NULL)
          OR
          (safety_state <> 'clear' AND subject_kind IS NOT NULL AND
           subject_id IS NOT NULL AND lease_id IS NOT NULL)
        ),
        CHECK (safety_state <> 'allocated' OR attempt_id IS NULL)
      );
      CREATE INDEX IF NOT EXISTS gpu_resource_fences_state_idx
        ON gpu_resource_fences (safety_state, worker_id, gpu_uuid);
      CREATE TABLE IF NOT EXISTS execution_attempts (
        attempt_id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('session','job')),
        subject_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(id),
        gpu_uuid TEXT NOT NULL,
        fence_epoch INTEGER NOT NULL CHECK(fence_epoch >= 1),
        artifact_digest TEXT NOT NULL,
        adapter_identity TEXT NOT NULL,
        runtime_policy_revision TEXT NOT NULL,
        approval_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('reserved','preparing','running','stopping','terminated','cleanup_required','quarantined')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cleanup_evidence_id TEXT,
        FOREIGN KEY (worker_id, gpu_uuid) REFERENCES gpu_resource_fences(worker_id, gpu_uuid) ON DELETE RESTRICT,
        CHECK(length(attempt_id) > 0 AND length(subject_id) > 0 AND
          length(project_id) > 0 AND length(lease_id) > 0 AND
          length(gpu_uuid) > 0 AND length(artifact_digest) > 0 AND
          length(adapter_identity) > 0 AND length(runtime_policy_revision) > 0 AND
          length(approval_ref) > 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_open_resource_idx
        ON execution_attempts (worker_id, gpu_uuid)
        WHERE status <> 'terminated';
      CREATE INDEX IF NOT EXISTS execution_attempts_lease_idx
        ON execution_attempts (subject_kind, subject_id, lease_id);
    `);
    const workerColumns = new Set(
      this.database.prepare("PRAGMA table_info(workers)").all().map((column) => column.name),
    );
    if (!workerColumns.has("adapter_manifests_json")) {
      this.database.exec(`
        ALTER TABLE workers
        ADD COLUMN adapter_manifests_json TEXT NOT NULL DEFAULT '[]';
      `);
    }
    if (!workerColumns.has("adapter_health_json")) {
      this.database.exec(`
        ALTER TABLE workers
        ADD COLUMN adapter_health_json TEXT NOT NULL DEFAULT '[]';
      `);
    }
    if (!workerColumns.has("model_inventory_json")) {
      this.database.exec(`
        ALTER TABLE workers
        ADD COLUMN model_inventory_json TEXT NOT NULL DEFAULT '[]';
      `);
    }
  }

  upsertWorker(worker) {
    const statement = this.database.prepare(`
      INSERT INTO workers (
        id, name, version, base_url, status, drain_mode, labels_json,
        capabilities_json, adapter_manifests_json, adapter_health_json,
        warm_models_json, model_inventory_json, gpu_inventory_json,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'online', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        base_url = excluded.base_url,
        status = 'online',
        labels_json = excluded.labels_json,
        capabilities_json = excluded.capabilities_json,
        adapter_manifests_json = excluded.adapter_manifests_json,
        adapter_health_json = excluded.adapter_health_json,
        warm_models_json = excluded.warm_models_json,
        model_inventory_json = excluded.model_inventory_json,
        gpu_inventory_json = excluded.gpu_inventory_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      RETURNING *
    `);
    return mapWorker(statement.get(
      worker.id,
      worker.name,
      worker.version,
      worker.baseUrl,
      stringifyJson(worker.labels),
      stringifyJson(worker.capabilities),
      stringifyJson(worker.adapterManifests),
      stringifyJson(worker.adapterHealth),
      stringifyJson(worker.warmModels),
      stringifyJson(worker.modelInventory),
      stringifyJson(worker.gpus),
      worker.now,
      worker.now,
      worker.now,
    ));
  }

  updateWorkerHeartbeat(workerId, heartbeat) {
    const statement = this.database.prepare(`
      UPDATE workers SET
        status = 'online',
        capabilities_json = ?,
        adapter_manifests_json = ?,
        adapter_health_json = ?,
        warm_models_json = ?,
        model_inventory_json = ?,
        gpu_inventory_json = ?,
        last_seen_at = ?,
        updated_at = ?
      WHERE id = ?
      RETURNING *
    `);
    const row = statement.get(
      stringifyJson(heartbeat.capabilities),
      stringifyJson(heartbeat.adapterManifests),
      stringifyJson(heartbeat.adapterHealth),
      stringifyJson(heartbeat.warmModels),
      stringifyJson(heartbeat.modelInventory),
      stringifyJson(heartbeat.gpus),
      heartbeat.now,
      heartbeat.now,
      workerId,
    );
    return row ? mapWorker(row) : null;
  }

  setWorkerDrain(workerId, drainMode, now) {
    const row = this.database.prepare(`
      UPDATE workers SET drain_mode = ?, updated_at = ?
      WHERE id = ? RETURNING *
    `).get(drainMode ? 1 : 0, now, workerId);
    return row ? mapWorker(row) : null;
  }

  listWorkers() {
    return this.database.prepare("SELECT * FROM workers ORDER BY name").all().map(mapWorker);
  }

  getWorker(workerId) {
    const row = this.database.prepare("SELECT * FROM workers WHERE id = ?").get(workerId);
    return row ? mapWorker(row) : null;
  }

  markStaleWorkersOffline(staleBefore, now) {
    const rows = this.database.prepare(`
      UPDATE workers SET status = 'offline', updated_at = ?
      WHERE status = 'online' AND last_seen_at < ?
      RETURNING id
    `).all(now, staleBefore);
    return rows.map((row) => row.id);
  }

  insertJob(job) {
    try {
      const row = this.database.prepare(`
        INSERT INTO jobs (
          id, project_id, type, priority, status, gpu_count, min_vram_mib,
          required_capabilities_json, requested_model, payload_json,
          attempt, max_attempts, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        RETURNING *
      `).get(
        job.id,
        job.projectId,
        job.type,
        job.priority,
        job.minVramMiB,
        stringifyJson(job.requiredCapabilities),
        job.requestedModel,
        stringifyJson(job.payload),
        job.maxAttempts,
        job.idempotencyKey,
        job.now,
        job.now,
      );
      return { job: mapJob(row), duplicate: false };
    } catch (error) {
      if (job.idempotencyKey && String(error.message).includes("UNIQUE constraint failed")) {
        const existing = this.database.prepare(`
          SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?
        `).get(job.projectId, job.idempotencyKey);
        return { job: mapJob(existing), duplicate: true };
      }
      throw error;
    }
  }

  getJob(jobId) {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    return row ? mapJob(row) : null;
  }

  listJobs({ status = null, workerId = null, limit = 100 } = {}) {
    const clauses = [];
    const parameters = [];
    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }
    if (workerId) {
      clauses.push("assigned_worker_id = ?");
      parameters.push(workerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`
      SELECT * FROM jobs ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(...parameters, limit).map(mapJob);
  }

  listQueuedJobs() {
    return this.database.prepare(`
      SELECT * FROM jobs WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC, id ASC
    `).all().map(mapJob);
  }

  listBlockedGpuResources() {
    return this.database.prepare(`
      SELECT worker_id AS workerId, gpu_uuid AS gpuUuid
      FROM gpu_resource_fences
      WHERE safety_state <> 'clear'
      ORDER BY worker_id, gpu_uuid
    `).all().map((row) => ({
      workerId: row.workerId,
      gpuUuid: row.gpuUuid,
    }));
  }

  // D1: a single-statement, read-only snapshot. Missing or mismatched records
  // are never evidence that the host GPU is clean or safe for reuse.
  observeExecutionAttempt(input) {
    return this.database.prepare(`
      SELECT a.attempt_id AS attemptId, a.fence_epoch AS fenceEpoch,
        a.worker_id AS workerId, a.gpu_uuid AS gpuUuid,
        a.subject_kind AS subjectKind, a.subject_id AS subjectId,
        a.lease_id AS leaseId, a.status AS attemptStatus,
        f.epoch AS currentFenceEpoch, f.safety_state AS fenceState,
        f.attempt_id AS fenceAttemptId, f.lease_id AS fenceLeaseId,
        f.subject_kind AS fenceSubjectKind, f.subject_id AS fenceSubjectId
      FROM execution_attempts a
      LEFT JOIN gpu_resource_fences f
        ON f.worker_id=a.worker_id AND f.gpu_uuid=a.gpu_uuid
      WHERE a.attempt_id=? AND a.worker_id=? AND a.project_id=?
        AND a.subject_kind=? AND a.subject_id=? AND a.lease_id=?
      LIMIT 1
    `).get(input.attemptId,input.workerId,input.projectId,
      input.subjectKind,input.subjectId,input.leaseId) ?? null;
  }

  reserveExecutionAttempt(rawInput) {
    // Must be called within SqlitePersistence.transaction (BEGIN IMMEDIATE).
    // No live broker callers; the returned record never grants launch.
    const input = validateExecutionClaim(rawInput);
    const worker = this.getWorker(input.workerId);
    const workload = input.subjectKind === "job"
      ? this.getJob(input.subjectId) : this.getSession(input.subjectId);
    validateCurrentExecutionOwner(input, worker, workload);
    const occupiedJob = this.database.prepare(`
      SELECT id FROM jobs WHERE assigned_worker_id=? AND assigned_gpu_uuid=?
        AND status IN ('leased','running') AND id <> ? LIMIT 1
    `).get(input.workerId,input.gpuUuid,input.subjectKind==='job'?input.subjectId:'');
    const occupiedSession = this.database.prepare(`
      SELECT id FROM sessions WHERE assigned_worker_id=? AND assigned_gpu_uuid=?
        AND status IN ('allocated','connecting','active') AND id <> ? LIMIT 1
    `).get(input.workerId,input.gpuUuid,input.subjectKind==='session'?input.subjectId:'');
    if (occupiedJob || occupiedSession) throw new ExecutionClaimDenied("resource_conflict");
    const row = this.database.prepare(`
      INSERT INTO gpu_resource_fences
        (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,attempt_id,updated_at)
      VALUES (?,?,1,'reserved',?,?,?,?,?)
      ON CONFLICT(worker_id,gpu_uuid) DO UPDATE SET
        epoch=gpu_resource_fences.epoch+1,
        safety_state='reserved',subject_kind=excluded.subject_kind,
        subject_id=excluded.subject_id,lease_id=excluded.lease_id,
        attempt_id=excluded.attempt_id,updated_at=excluded.updated_at
      WHERE gpu_resource_fences.safety_state='clear'
      RETURNING epoch
    `).get(input.workerId,input.gpuUuid,input.subjectKind,input.subjectId,
      input.leaseId,input.attemptId,input.now);
    if (!row) throw new ExecutionClaimDenied("resource_held");
    this.database.prepare(`
      INSERT INTO execution_attempts
        (attempt_id,subject_kind,subject_id,project_id,lease_id,worker_id,gpu_uuid,
         fence_epoch,artifact_digest,adapter_identity,runtime_policy_revision,
         approval_ref,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)
    `).run(input.attemptId,input.subjectKind,input.subjectId,workload.projectId,
      input.leaseId,input.workerId,input.gpuUuid,row.epoch,input.artifactDigest,
      input.adapterIdentity,input.runtimePolicyRevision,input.approvalRef,input.now,input.now);
    return {attemptId:input.attemptId,fenceEpoch:row.epoch,canLaunch:false};
  }

  listActiveJobs() {
    return this.database.prepare(`
      SELECT * FROM jobs WHERE status IN ('leased', 'running')
    `).all().map(mapJob);
  }

  assignJob(jobId, placement, leaseId, leaseExpiresAt, now) {
    const row = this.database.prepare(`
      UPDATE jobs SET
        status = 'leased',
        assigned_worker_id = ?,
        assigned_gpu_uuid = ?,
        lease_id = ?,
        lease_expires_at = ?,
        attempt = attempt + 1,
        updated_at = ?
      WHERE id = ? AND status = 'queued'
      RETURNING *
    `).get(
      placement.workerId,
      placement.gpuUuid,
      leaseId,
      leaseExpiresAt,
      now,
      jobId,
    );
    return row ? mapJob(row) : null;
  }

  startJob(jobId, workerId, leaseId, leaseExpiresAt, now) {
    const row = this.database.prepare(`
      UPDATE jobs SET status = 'running', lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased'
        AND assigned_worker_id = ? AND lease_id = ? AND lease_expires_at > ?
      RETURNING *
    `).get(leaseExpiresAt, now, jobId, workerId, leaseId, now);
    return row ? mapJob(row) : null;
  }

  renewJob(jobId, workerId, leaseId, leaseExpiresAt, now) {
    const row = this.database.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
        AND assigned_worker_id = ? AND lease_id = ? AND lease_expires_at > ?
      RETURNING *
    `).get(leaseExpiresAt, now, jobId, workerId, leaseId, now);
    return row ? mapJob(row) : null;
  }

  finishJob(jobId, workerId, leaseId, status, result, error, now) {
    const row = this.database.prepare(`
      UPDATE jobs SET
        status = ?, result_json = ?, error_json = ?,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'running')
        AND assigned_worker_id = ? AND lease_id = ? AND lease_expires_at > ?
      RETURNING *
    `).get(
      status,
      result === null ? null : stringifyJson(result),
      error === null ? null : stringifyJson(error),
      now,
      jobId,
      workerId,
      leaseId,
      now,
    );
    return row ? mapJob(row) : null;
  }

  cancelJob(jobId, now) {
    const row = this.database.prepare(`
      UPDATE jobs SET status = 'cancelled', lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'leased', 'running')
      RETURNING *
    `).get(now, jobId);
    return row ? mapJob(row) : null;
  }

  recoverExpiredJobs(now, offlineWorkerIds = []) {
    const offlineWorkerIdSet = new Set(offlineWorkerIds);
    const active = this.listActiveJobs().filter((job) =>
      (job.leaseExpiresAt !== null && job.leaseExpiresAt <= now) ||
      offlineWorkerIdSet.has(job.assignedWorkerId));
    const recovered = [];

    for (const job of active) {
      const reason = offlineWorkerIdSet.has(job.assignedWorkerId)
        ? "heartbeat_timeout"
        : "lease_expired";
      const terminal = job.attempt >= job.maxAttempts;
      const status = terminal ? "failed" : "queued";
      const error = terminal
        ? stringifyJson({ code: "lease_exhausted", message: "Job exhausted its execution attempts" })
        : null;
      const row = this.database.prepare(`
        UPDATE jobs SET
          status = ?, assigned_worker_id = NULL, assigned_gpu_uuid = NULL,
          lease_id = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('leased', 'running')
        RETURNING *
      `).get(status, error, now, job.id);
      if (row) recovered.push({ job: mapJob(row), reason });
    }
    return recovered;
  }

  insertSession(session) {
    try {
      const row = this.database.prepare(`
        INSERT INTO sessions (
          id,
          schema_version,
          project_id,
          capability,
          priority,
          status,
          gpu_count,
          min_vram_mib,
          required_capabilities_json,
          requested_model,
          requested_adapter,
          metadata_json,
          max_interruptions,
          interruption_count,
          idempotency_key,
          created_at,
          updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'requested',
          1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
        )
        RETURNING *
      `).get(
        session.id,
        session.schemaVersion,
        session.projectId,
        session.capability,
        session.priority,
        session.requirements.minVramMiB,
        stringifyJson(
          session.requirements.capabilities,
        ),
        session.requirements.model,
        session.requirements.adapter,
        stringifyJson(session.metadata),
        session.recovery.maxInterruptions,
        session.idempotencyKey,
        session.now,
        session.now,
      );

      return {
        session: mapSession(row),
        duplicate: false,
      };
    } catch (error) {
      if (
        session.idempotencyKey &&
        String(error.message)
          .includes("UNIQUE constraint failed")
      ) {
        const existing =
          this.database.prepare(`
            SELECT *
            FROM sessions
            WHERE project_id = ?
              AND idempotency_key = ?
          `).get(
            session.projectId,
            session.idempotencyKey,
          );

        return {
          session: mapSession(existing),
          duplicate: true,
        };
      }

      throw error;
    }
  }

  getSession(sessionId) {
    const row =
      this.database.prepare(`
        SELECT *
        FROM sessions
        WHERE id = ?
      `).get(sessionId);

    return row
      ? mapSession(row)
      : null;
  }

  listSessions({
    status = null,
    workerId = null,
    limit = 100,
  } = {}) {
    const clauses = [];
    const parameters = [];

    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }

    if (workerId) {
      clauses.push(
        "assigned_worker_id = ?",
      );
      parameters.push(workerId);
    }

    const where =
      clauses.length > 0
        ? `WHERE ${clauses.join(" AND ")}`
        : "";

    return this.database.prepare(`
      SELECT *
      FROM sessions
      ${where}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `).all(
      ...parameters,
      limit,
    ).map(mapSession);
  }

  listRequestedSessions() {
    return this.database.prepare(`
      SELECT *
      FROM sessions
      WHERE status = 'requested'
      ORDER BY
        priority DESC,
        created_at ASC,
        id ASC
    `).all().map(mapSession);
  }

  listOccupyingSessions() {
    return this.database.prepare(`
      SELECT *
      FROM sessions
      WHERE status IN (
        'allocated',
        'connecting',
        'active'
      )
      ORDER BY created_at ASC, id ASC
    `).all().map(mapSession);
  }

  assignSession(
    sessionId,
    placement,
    leaseId,
    leaseExpiresAt,
    now,
  ) {
    const row =
      this.database.prepare(`
        UPDATE sessions
        SET
          status = 'allocated',
          assigned_worker_id = ?,
          assigned_gpu_uuid = ?,
          lease_id = ?,
          lease_expires_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'requested'
        RETURNING *
      `).get(
        placement.workerId,
        placement.gpuUuid,
        leaseId,
        leaseExpiresAt,
        now,
        sessionId,
      );

    return row
      ? mapSession(row)
      : null;
  }

  startSession(
    sessionId,
    workerId,
    leaseId,
    leaseExpiresAt,
    now,
  ) {
    const row =
      this.database.prepare(`
        UPDATE sessions
        SET
          status = 'connecting',
          lease_expires_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'allocated'
          AND assigned_worker_id = ?
          AND lease_id = ?
          AND lease_expires_at > ?
        RETURNING *
      `).get(
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      );

    return row
      ? mapSession(row)
      : null;
  }

  activateSession(
    sessionId,
    workerId,
    leaseId,
    leaseExpiresAt,
    now,
  ) {
    const row =
      this.database.prepare(`
        UPDATE sessions
        SET
          status = 'active',
          lease_expires_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'connecting'
          AND assigned_worker_id = ?
          AND lease_id = ?
          AND lease_expires_at > ?
        RETURNING *
      `).get(
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      );

    return row
      ? mapSession(row)
      : null;
  }

  renewSession(
    sessionId,
    workerId,
    leaseId,
    leaseExpiresAt,
    now,
  ) {
    const row =
      this.database.prepare(`
        UPDATE sessions
        SET
          lease_expires_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN (
            'allocated',
            'connecting',
            'active'
          )
          AND assigned_worker_id = ?
          AND lease_id = ?
          AND lease_expires_at > ?
        RETURNING *
      `).get(
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      );

    return row
      ? mapSession(row)
      : null;
  }

  closeSession(
    sessionId,
    now,
  ) {
    const row =
      this.database.prepare(`
        UPDATE sessions
        SET
          status = 'closed',
          assigned_worker_id = NULL,
          assigned_gpu_uuid = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = ?
        WHERE id = ?
          AND status IN (
            'requested',
            'allocated',
            'connecting',
            'active'
          )
        RETURNING *
      `).get(
        now,
        sessionId,
      );

    return row
      ? mapSession(row)
      : null;
  }

  recoverInterruptedSessions(
    now,
    offlineWorkerIds = [],
  ) {
    const offlineWorkerIdSet =
      new Set(offlineWorkerIds);

    const active =
      this.listOccupyingSessions()
        .filter(
          (session) =>
            (
              session.leaseExpiresAt !== null &&
              session.leaseExpiresAt <= now
            ) ||
            offlineWorkerIdSet.has(
              session.assignedWorkerId,
            ),
        );

    const recovered = [];

    for (const session of active) {
      const reason =
        offlineWorkerIdSet.has(
          session.assignedWorkerId,
        )
          ? "heartbeat_timeout"
          : "lease_expired";

      const previousStatus =
        session.status;

      const interruptionCount =
        session.interruptionCount + 1;

      const replacementAllowed =
        interruptionCount <=
        session.recovery
          .maxInterruptions;

      const status =
        replacementAllowed
          ? "requested"
          : "interrupted";

      const row =
        this.database.prepare(`
          UPDATE sessions
          SET
            status = ?,
            interruption_count = ?,
            assigned_worker_id = NULL,
            assigned_gpu_uuid = NULL,
            lease_id = NULL,
            lease_expires_at = NULL,
            updated_at = ?
          WHERE id = ?
            AND status IN (
              'allocated',
              'connecting',
              'active'
            )
          RETURNING *
        `).get(
          status,
          interruptionCount,
          now,
          session.id,
        );

      if (row) {
        recovered.push({
          session: mapSession(row),
          reason,
          previousStatus,
        });
      }
    }

    return recovered;
  }

  appendEvent(type, subjectId, payload, now) {
    const row = this.database.prepare(`
      INSERT INTO events(type, subject_id, payload_json, created_at)
      VALUES (?, ?, ?, ?) RETURNING *
    `).get(type, subjectId, stringifyJson(payload), now);
    this.database.prepare(`
      DELETE FROM events
      WHERE sequence <= COALESCE((SELECT MAX(sequence) - 10000 FROM events), 0)
    `).run();
    return mapEvent(row);
  }

  listEventsAfter(sequence, limit = 500) {
    return this.database.prepare(`
      SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(sequence, limit).map(mapEvent);
  }

  counts() {
    const workerCounts = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM workers GROUP BY status
    `).all().map((row) => [row.status, Number(row.count)]));
    const jobCounts = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM jobs GROUP BY status
    `).all().map((row) => [row.status, Number(row.count)]));
    return { workerCounts, jobCounts };
  }
}

function mapWorker(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    baseUrl: row.base_url,
    status: row.status,
    drainMode: Boolean(row.drain_mode),
    labels: parseJson(row.labels_json, {}),
    capabilities: parseJson(row.capabilities_json, []),
    adapterManifests: parseJson(row.adapter_manifests_json, []),
    adapterHealth: parseJson(row.adapter_health_json, []),
    warmModels: parseJson(row.warm_models_json, []),
    modelInventory: parseJson(row.model_inventory_json, []),
    gpus: parseJson(row.gpu_inventory_json, []),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    constraints: {
      gpuCount: row.gpu_count,
      minVramMiB: row.min_vram_mib,
      capabilities: parseJson(row.required_capabilities_json, []),
      model: row.requested_model,
    },
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    error: parseJson(row.error_json, null),
    assignedWorkerId: row.assigned_worker_id,
    assignedGpuUuid: row.assigned_gpu_uuid,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    projectId: row.project_id,
    capability: row.capability,
    priority: row.priority,
    status: row.status,
    requirements: {
      gpuCount: row.gpu_count,
      minVramMiB: row.min_vram_mib,
      capabilities:
        parseJson(
          row.required_capabilities_json,
          [],
        ),
      model: row.requested_model,
      adapter: row.requested_adapter,
    },
    metadata:
      parseJson(
        row.metadata_json,
        {},
      ),
    recovery: {
      maxInterruptions:
        row.max_interruptions,
    },
    interruptionCount:
      row.interruption_count,
    assignedWorkerId:
      row.assigned_worker_id,
    assignedGpuUuid:
      row.assigned_gpu_uuid,
    leaseId:
      row.lease_id,
    leaseExpiresAt:
      row.lease_expires_at,
    idempotencyKey:
      row.idempotency_key,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at,
  };
}

function mapEvent(row) {
  return {
    sequence: Number(row.sequence),
    type: row.type,
    subjectId: row.subject_id,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

export { ACTIVE_JOB_STATES };
