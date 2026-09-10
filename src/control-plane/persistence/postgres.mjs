import {
  createHash,
} from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import {
  fileURLToPath,
} from "node:url";

import pg from "pg";

import {
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "./contract.mjs";

const { Pool } = pg;

const DEFAULT_MIGRATIONS_DIRECTORY =
  fileURLToPath(
    new URL(
      "./migrations/postgres/",
      import.meta.url,
    ),
  );

const MIGRATION_LOCK_NAME =
  "gpulink-schema-migrations";

export class PostgresPersistence {
  #pool;
  #migrationsDirectory;
  #initializePromise = null;
  #initialized = false;
  #closePromise = null;
  #closed = false;

  constructor(
    connectionString,
    {
      maxConnections = 10,
      idleTimeoutMs = 30_000,
      connectionTimeoutMs = 5_000,
      migrationsDirectory =
        DEFAULT_MIGRATIONS_DIRECTORY,
    } = {},
  ) {
    if (
      typeof connectionString !== "string" ||
      connectionString.trim() === ""
    ) {
      throw new TypeError(
        "PostgreSQL connection string must be a non-empty string",
      );
    }

    if (
      !Number.isSafeInteger(maxConnections) ||
      maxConnections <= 0
    ) {
      throw new TypeError(
        "maxConnections must be a positive integer",
      );
    }

    this.#migrationsDirectory =
      migrationsDirectory;

    this.#pool = new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: idleTimeoutMs,
      connectionTimeoutMillis:
        connectionTimeoutMs,
    });

    this.#pool.on(
      "error",
      (error) => {
        console.error(
          "PostgreSQL pool error",
          error,
        );
      },
    );

    assertPersistenceContract(this);
  }

  initialize() {
    if (this.#closed) {
      return Promise.reject(
        new Error(
          "PostgreSQL persistence is closed",
        ),
      );
    }

    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#initializePromise =
      this.#initialize()
        .catch((error) => {
          this.#initializePromise = null;
          throw error;
        });

    return this.#initializePromise;
  }

  async #initialize() {
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtext($1)::bigint
          )
        `,
        [MIGRATION_LOCK_NAME],
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS
          gpulink_schema_migrations (
            filename TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ
              NOT NULL DEFAULT NOW()
          )
      `);

      const entries =
        await readdir(
          this.#migrationsDirectory,
          {
            withFileTypes: true,
          },
        );

      const filenames =
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith(".sql"),
          )
          .map((entry) => entry.name)
          .sort();

      for (const filename of filenames) {
        const migrationPath =
          path.join(
            this.#migrationsDirectory,
            filename,
          );

        const sql =
          await readFile(
            migrationPath,
            "utf8",
          );

        const checksum =
          createHash("sha256")
            .update(sql)
            .digest("hex");

        const existing =
          await client.query(
            `
              SELECT checksum
              FROM gpulink_schema_migrations
              WHERE filename = $1
            `,
            [filename],
          );

        if (existing.rowCount > 0) {
          if (
            existing.rows[0].checksum !==
            checksum
          ) {
            throw new Error(
              `PostgreSQL migration ${filename} has changed after being applied`,
            );
          }

          continue;
        }

        await client.query(sql);

        await client.query(
          `
            INSERT INTO
              gpulink_schema_migrations (
                filename,
                checksum
              )
            VALUES ($1, $2)
          `,
          [
            filename,
            checksum,
          ],
        );
      }

      await client.query("COMMIT");

      this.#initialized = true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [
            error,
            rollbackError,
          ],
          "PostgreSQL migration rollback failed",
        );
      }

      throw error;
    } finally {
      client.release();
    }

    return this;
  }

  async transaction(callback) {
    this.#assertReady();

    if (typeof callback !== "function") {
      throw new TypeError(
        "transaction callback must be a function",
      );
    }

    const client =
      await this.#pool.connect();

    try {
      await client.query("BEGIN");

      const transaction =
        this.#createTransactionView(
          client,
        );

      const result =
        await callback(transaction);

      await client.query("COMMIT");

      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [
            error,
            rollbackError,
          ],
          "PostgreSQL transaction rollback failed",
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closed = true;

    this.#closePromise =
      (async () => {
        if (this.#initializePromise) {
          try {
            await this.#initializePromise;
          } catch {
            // Initialization failure does not
            // prevent the pool from closing.
          }
        }

        await this.#pool.end();
        this.#initialized = false;
      })();

    return this.#closePromise;
  }

  upsertWorker(...args) {
    return this.#call(
      "upsertWorker",
      args,
    );
  }

  updateWorkerHeartbeat(...args) {
    return this.#call(
      "updateWorkerHeartbeat",
      args,
    );
  }

  setWorkerDrain(...args) {
    return this.#call(
      "setWorkerDrain",
      args,
    );
  }

  listWorkers(...args) {
    return this.#call(
      "listWorkers",
      args,
    );
  }

  getWorker(...args) {
    return this.#call(
      "getWorker",
      args,
    );
  }

  markStaleWorkersOffline(...args) {
    return this.#call(
      "markStaleWorkersOffline",
      args,
    );
  }

  insertJob(...args) {
    return this.#call(
      "insertJob",
      args,
    );
  }

  getJob(...args) {
    return this.#call(
      "getJob",
      args,
    );
  }

  listJobs(...args) {
    return this.#call(
      "listJobs",
      args,
    );
  }

  listQueuedJobs(...args) {
    return this.#call(
      "listQueuedJobs",
      args,
    );
  }

  listActiveJobs(...args) {
    return this.#call(
      "listActiveJobs",
      args,
    );
  }

  assignJob(...args) {
    return this.#call(
      "assignJob",
      args,
    );
  }

  startJob(...args) {
    return this.#call(
      "startJob",
      args,
    );
  }

  renewJob(...args) {
    return this.#call(
      "renewJob",
      args,
    );
  }

  finishJob(...args) {
    return this.#call(
      "finishJob",
      args,
    );
  }

  cancelJob(...args) {
    return this.#call(
      "cancelJob",
      args,
    );
  }

  recoverExpiredJobs(...args) {
    return this.#call(
      "recoverExpiredJobs",
      args,
    );
  }

  appendEvent(...args) {
    return this.#call(
      "appendEvent",
      args,
    );
  }

  listEventsAfter(...args) {
    return this.#call(
      "listEventsAfter",
      args,
    );
  }

  counts(...args) {
    return this.#call(
      "counts",
      args,
    );
  }

  #createTransactionView(client) {
    const transaction = {};

    for (
      const method of
      PERSISTENCE_METHODS
    ) {
      transaction[method] =
        (...args) =>
          this.#call(
            method,
            args,
            client,
          );
    }

    return Object.freeze(
      transaction,
    );
  }

  #call(method, args, client = null) {
    this.#assertReady();

    const queryable =
      client ?? this.#pool;

    switch (method) {
      case "upsertWorker":
        return postgresUpsertWorker(
          queryable,
          ...args,
        );

      case "updateWorkerHeartbeat":
        return postgresUpdateWorkerHeartbeat(
          queryable,
          ...args,
        );

      case "setWorkerDrain":
        return postgresSetWorkerDrain(
          queryable,
          ...args,
        );

      case "listWorkers":
        return postgresListWorkers(
          queryable,
          ...args,
        );

      case "getWorker":
        return postgresGetWorker(
          queryable,
          ...args,
        );

      case "markStaleWorkersOffline":
        return postgresMarkStaleWorkersOffline(
          queryable,
          ...args,
        );

      case "insertJob":
        return postgresInsertJob(
          queryable,
          ...args,
        );

      case "getJob":
        return postgresGetJob(
          queryable,
          ...args,
        );

      case "listJobs":
        return postgresListJobs(
          queryable,
          ...args,
        );

      case "listQueuedJobs":
        return postgresListQueuedJobs(
          queryable,
          ...args,
        );

      case "listActiveJobs":
        return postgresListActiveJobs(
          queryable,
          ...args,
        );

      case "appendEvent":
        return postgresAppendEvent(
          queryable,
          ...args,
        );

      case "listEventsAfter":
        return postgresListEventsAfter(
          queryable,
          ...args,
        );

      default:
        return Promise.reject(
          new Error(
            `PostgreSQL persistence method ${method} is not implemented`,
            {
              cause: {
                method,
                argumentCount:
                  args.length,
                transactional:
                  client !== null,
              },
            },
          ),
        );
    }
  }

  #assertReady() {
    if (this.#closed) {
      throw new Error(
        "PostgreSQL persistence is closed",
      );
    }

    if (!this.#initialized) {
      throw new Error(
        "PostgreSQL persistence is not initialized",
      );
    }
  }
}


async function postgresUpsertWorker(
  queryable,
  worker,
) {
  const result =
    await queryable.query(
      `
        INSERT INTO workers (
          id,
          name,
          version,
          base_url,
          status,
          drain_mode,
          labels_json,
          capabilities_json,
          adapter_manifests_json,
          adapter_health_json,
          warm_models_json,
          model_inventory_json,
          gpu_inventory_json,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'online',
          FALSE,
          $5::jsonb,
          $6::jsonb,
          $7::jsonb,
          $8::jsonb,
          $9::jsonb,
          $10::jsonb,
          $11::jsonb,
          $12,
          $13,
          $14
        )
        ON CONFLICT (name)
        DO UPDATE SET
          version =
            EXCLUDED.version,
          base_url =
            EXCLUDED.base_url,
          status =
            'online',
          labels_json =
            EXCLUDED.labels_json,
          capabilities_json =
            EXCLUDED.capabilities_json,
          adapter_manifests_json =
            EXCLUDED.adapter_manifests_json,
          adapter_health_json =
            EXCLUDED.adapter_health_json,
          warm_models_json =
            EXCLUDED.warm_models_json,
          model_inventory_json =
            EXCLUDED.model_inventory_json,
          gpu_inventory_json =
            EXCLUDED.gpu_inventory_json,
          last_seen_at =
            EXCLUDED.last_seen_at,
          updated_at =
            EXCLUDED.updated_at
        RETURNING *
      `,
      [
        worker.id,
        worker.name,
        worker.version,
        worker.baseUrl,
        JSON.stringify(
          worker.labels,
        ),
        JSON.stringify(
          worker.capabilities,
        ),
        JSON.stringify(
          worker.adapterManifests,
        ),
        JSON.stringify(
          worker.adapterHealth,
        ),
        JSON.stringify(
          worker.warmModels,
        ),
        JSON.stringify(
          worker.modelInventory,
        ),
        JSON.stringify(
          worker.gpus,
        ),
        worker.now,
        worker.now,
        worker.now,
      ],
    );

  return mapPostgresWorker(
    result.rows[0],
  );
}

async function postgresUpdateWorkerHeartbeat(
  queryable,
  workerId,
  heartbeat,
) {
  const result =
    await queryable.query(
      `
        UPDATE workers
        SET
          status = 'online',
          capabilities_json =
            $1::jsonb,
          adapter_manifests_json =
            $2::jsonb,
          adapter_health_json =
            $3::jsonb,
          warm_models_json =
            $4::jsonb,
          model_inventory_json =
            $5::jsonb,
          gpu_inventory_json =
            $6::jsonb,
          last_seen_at = $7,
          updated_at = $8
        WHERE id = $9
        RETURNING *
      `,
      [
        JSON.stringify(
          heartbeat.capabilities,
        ),
        JSON.stringify(
          heartbeat.adapterManifests,
        ),
        JSON.stringify(
          heartbeat.adapterHealth,
        ),
        JSON.stringify(
          heartbeat.warmModels,
        ),
        JSON.stringify(
          heartbeat.modelInventory,
        ),
        JSON.stringify(
          heartbeat.gpus,
        ),
        heartbeat.now,
        heartbeat.now,
        workerId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresWorker(
        result.rows[0],
      )
    : null;
}

async function postgresSetWorkerDrain(
  queryable,
  workerId,
  drainMode,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE workers
        SET
          drain_mode = $1,
          updated_at = $2
        WHERE id = $3
        RETURNING *
      `,
      [
        Boolean(drainMode),
        now,
        workerId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresWorker(
        result.rows[0],
      )
    : null;
}

async function postgresListWorkers(
  queryable,
) {
  const result =
    await queryable.query(`
      SELECT *
      FROM workers
      ORDER BY name
    `);

  return result.rows.map(
    mapPostgresWorker,
  );
}

async function postgresGetWorker(
  queryable,
  workerId,
) {
  const result =
    await queryable.query(
      `
        SELECT *
        FROM workers
        WHERE id = $1
      `,
      [workerId],
    );

  return result.rowCount > 0
    ? mapPostgresWorker(
        result.rows[0],
      )
    : null;
}

async function postgresMarkStaleWorkersOffline(
  queryable,
  staleBefore,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE workers
        SET
          status = 'offline',
          updated_at = $1
        WHERE
          status = 'online'
          AND last_seen_at < $2
        RETURNING id
      `,
      [
        now,
        staleBefore,
      ],
    );

  return result.rows.map(
    (row) => row.id,
  );
}

function mapPostgresWorker(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    baseUrl: row.base_url,
    status: row.status,
    drainMode:
      Boolean(row.drain_mode),
    labels:
      row.labels_json ?? {},
    capabilities:
      row.capabilities_json ?? [],
    adapterManifests:
      row.adapter_manifests_json ?? [],
    adapterHealth:
      row.adapter_health_json ?? [],
    warmModels:
      row.warm_models_json ?? [],
    modelInventory:
      row.model_inventory_json ?? [],
    gpus:
      row.gpu_inventory_json ?? [],
    lastSeenAt:
      Number(row.last_seen_at),
    createdAt:
      Number(row.created_at),
    updatedAt:
      Number(row.updated_at),
  };
}


async function postgresAppendEvent(
  queryable,
  type,
  subjectId,
  payload,
  now,
) {
  const inserted =
    await queryable.query(
      `
        INSERT INTO events (
          type,
          subject_id,
          payload_json,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3::jsonb,
          $4
        )
        RETURNING *
      `,
      [
        type,
        subjectId,
        JSON.stringify(payload),
        now,
      ],
    );

  await queryable.query(`
    DELETE FROM events
    WHERE sequence <= COALESCE(
      (
        SELECT MAX(sequence) - 10000
        FROM events
      ),
      0
    )
  `);

  return mapPostgresEvent(
    inserted.rows[0],
  );
}

async function postgresListEventsAfter(
  queryable,
  sequence,
  limit = 500,
) {
  const result =
    await queryable.query(
      `
        SELECT *
        FROM events
        WHERE sequence > $1
        ORDER BY sequence ASC
        LIMIT $2
      `,
      [
        sequence,
        limit,
      ],
    );

  return result.rows.map(
    mapPostgresEvent,
  );
}

function mapPostgresEvent(row) {
  return {
    sequence:
      Number(row.sequence),
    type:
      row.type,
    subjectId:
      row.subject_id,
    payload:
      row.payload_json ?? {},
    createdAt:
      Number(row.created_at),
  };
}


async function postgresInsertJob(
  queryable,
  job,
) {
  const result =
    await queryable.query(
      `
        INSERT INTO jobs (
          id,
          project_id,
          type,
          priority,
          status,
          gpu_count,
          min_vram_mib,
          required_capabilities_json,
          requested_model,
          payload_json,
          attempt,
          max_attempts,
          idempotency_key,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'queued',
          1,
          $5,
          $6::jsonb,
          $7,
          $8::jsonb,
          0,
          $9,
          $10,
          $11,
          $12
        )
        ON CONFLICT (
          project_id,
          idempotency_key
        )
        DO NOTHING
        RETURNING *
      `,
      [
        job.id,
        job.projectId,
        job.type,
        job.priority,
        job.minVramMiB,
        JSON.stringify(
          job.requiredCapabilities,
        ),
        job.requestedModel,
        JSON.stringify(job.payload),
        job.maxAttempts,
        job.idempotencyKey,
        job.now,
        job.now,
      ],
    );

  if (result.rowCount > 0) {
    return {
      job: mapPostgresJob(
        result.rows[0],
      ),
      duplicate: false,
    };
  }

  if (job.idempotencyKey !== null) {
    const existing =
      await queryable.query(
        `
          SELECT *
          FROM jobs
          WHERE
            project_id = $1
            AND idempotency_key = $2
        `,
        [
          job.projectId,
          job.idempotencyKey,
        ],
      );

    if (existing.rowCount > 0) {
      return {
        job: mapPostgresJob(
          existing.rows[0],
        ),
        duplicate: true,
      };
    }
  }

  throw new Error(
    "PostgreSQL job insert returned no row",
  );
}

async function postgresGetJob(
  queryable,
  jobId,
) {
  const result =
    await queryable.query(
      `
        SELECT *
        FROM jobs
        WHERE id = $1
      `,
      [jobId],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}

async function postgresListJobs(
  queryable,
  {
    status = null,
    workerId = null,
    limit = 100,
  } = {},
) {
  const clauses = [];
  const parameters = [];

  if (status) {
    parameters.push(status);
    clauses.push(
      `status = $${parameters.length}`,
    );
  }

  if (workerId) {
    parameters.push(workerId);
    clauses.push(
      `assigned_worker_id = $${parameters.length}`,
    );
  }

  const where =
    clauses.length > 0
      ? `WHERE ${clauses.join(" AND ")}`
      : "";

  parameters.push(limit);

  const result =
    await queryable.query(
      `
        SELECT *
        FROM jobs
        ${where}
        ORDER BY created_at DESC
        LIMIT $${parameters.length}
      `,
      parameters,
    );

  return result.rows.map(
    mapPostgresJob,
  );
}

async function postgresListQueuedJobs(
  queryable,
) {
  const result =
    await queryable.query(`
      SELECT *
      FROM jobs
      WHERE status = 'queued'
      ORDER BY
        priority DESC,
        created_at ASC,
        id ASC
    `);

  return result.rows.map(
    mapPostgresJob,
  );
}

async function postgresListActiveJobs(
  queryable,
) {
  const result =
    await queryable.query(`
      SELECT *
      FROM jobs
      WHERE status IN (
        'leased',
        'running'
      )
    `);

  return result.rows.map(
    mapPostgresJob,
  );
}

function mapPostgresJob(row) {
  return {
    id:
      row.id,
    projectId:
      row.project_id,
    type:
      row.type,
    priority:
      Number(row.priority),
    status:
      row.status,
    constraints: {
      gpuCount:
        Number(row.gpu_count),
      minVramMiB:
        Number(row.min_vram_mib),
      capabilities:
        row.required_capabilities_json ??
        [],
      model:
        row.requested_model,
    },
    payload:
      row.payload_json ?? {},
    result:
      row.result_json ?? null,
    error:
      row.error_json ?? null,
    assignedWorkerId:
      row.assigned_worker_id,
    assignedGpuUuid:
      row.assigned_gpu_uuid,
    leaseId:
      row.lease_id,
    leaseExpiresAt:
      row.lease_expires_at === null
        ? null
        : Number(
            row.lease_expires_at,
          ),
    attempt:
      Number(row.attempt),
    maxAttempts:
      Number(row.max_attempts),
    idempotencyKey:
      row.idempotency_key,
    createdAt:
      Number(row.created_at),
    updatedAt:
      Number(row.updated_at),
  };
}
