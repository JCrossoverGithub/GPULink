import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJson, stringifyJson } from "../shared/json.mjs";

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
        warm_models_json TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        subject_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  upsertWorker(worker) {
    const statement = this.database.prepare(`
      INSERT INTO workers (
        id, name, version, base_url, status, drain_mode, labels_json,
        capabilities_json, warm_models_json, gpu_inventory_json,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'online', 0, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        base_url = excluded.base_url,
        status = 'online',
        labels_json = excluded.labels_json,
        capabilities_json = excluded.capabilities_json,
        warm_models_json = excluded.warm_models_json,
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
      stringifyJson(worker.warmModels),
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
        warm_models_json = ?,
        gpu_inventory_json = ?,
        last_seen_at = ?,
        updated_at = ?
      WHERE id = ?
      RETURNING *
    `);
    const row = statement.get(
      stringifyJson(heartbeat.capabilities),
      stringifyJson(heartbeat.warmModels),
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
    const active = this.listActiveJobs().filter((job) =>
      (job.leaseExpiresAt !== null && job.leaseExpiresAt <= now) ||
      offlineWorkerIds.includes(job.assignedWorkerId));
    const recovered = [];

    for (const job of active) {
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
      if (row) recovered.push(mapJob(row));
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
    warmModels: parseJson(row.warm_models_json, []),
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
