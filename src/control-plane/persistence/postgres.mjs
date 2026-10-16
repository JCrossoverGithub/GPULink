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
import { validateExecutionClaim, validateCurrentExecutionOwner, ExecutionClaimDenied } from "../execution-claim-authority.mjs";

import {
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "./contract.mjs";

const { Client, Pool } = pg;

const EVENT_NOTIFICATION_CHANNEL =
  "gpulink_events";

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
  #connectionString;
  #connectionTimeoutMs;
  #migrationsDirectory;
  #eventSubscribers = new Set();
  #eventListenerClient = null;
  #eventListenerPromise = null;
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

    this.#connectionString =
      connectionString;

    this.#connectionTimeoutMs =
      connectionTimeoutMs;

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

  async subscribeToEvents(listener) {
    this.#assertReady();

    if (typeof listener !== "function") {
      throw new TypeError(
        "event listener must be a function",
      );
    }

    this.#eventSubscribers.add(
      listener,
    );

    try {
      await this.#ensureEventListener();
    } catch (error) {
      this.#eventSubscribers.delete(
        listener,
      );

      throw error;
    }

    let subscribed = true;

    return async () => {
      if (!subscribed) return;

      subscribed = false;

      this.#eventSubscribers.delete(
        listener,
      );

      if (
        this.#eventSubscribers.size === 0
      ) {
        await this.#stopEventListener();
      }
    };
  }

  async #ensureEventListener() {
    if (this.#eventListenerClient) {
      return;
    }

    if (this.#eventListenerPromise) {
      return this.#eventListenerPromise;
    }

    this.#eventListenerPromise =
      (async () => {
        const client =
          new Client({
            connectionString:
              this.#connectionString,
            connectionTimeoutMillis:
              this.#connectionTimeoutMs,
          });

        client.on(
          "notification",
          (message) => {
            if (
              message.channel !==
              EVENT_NOTIFICATION_CHANNEL
            ) {
              return;
            }

            const sequence =
              Number(message.payload);

            this.#notifyEventSubscribers(
              Number.isSafeInteger(sequence)
                ? sequence
                : null,
            );
          },
        );

        client.on(
          "error",
          (error) => {
            console.error(
              "PostgreSQL event listener error",
              error,
            );
          },
        );

        try {
          await client.connect();

          await client.query(
            `LISTEN ${EVENT_NOTIFICATION_CHANNEL}`,
          );
        } catch (error) {
          try {
            await client.end();
          } catch {
            // Preserve the original connection error.
          }

          throw error;
        }

        this.#eventListenerClient =
          client;
      })();

    try {
      await this.#eventListenerPromise;
    } finally {
      this.#eventListenerPromise = null;
    }
  }

  async #stopEventListener() {
    if (this.#eventListenerPromise) {
      try {
        await this.#eventListenerPromise;
      } catch {
        // A failed listener startup has nothing
        // left to close.
      }
    }

    const client =
      this.#eventListenerClient;

    this.#eventListenerClient = null;

    if (!client) return;

    try {
      await client.query(
        `UNLISTEN ${EVENT_NOTIFICATION_CHANNEL}`,
      );
    } finally {
      await client.end();
    }
  }

  #notifyEventSubscribers(sequence) {
    for (
      const listener of
      this.#eventSubscribers
    ) {
      try {
        Promise.resolve(
          listener(sequence),
        ).catch(
          (error) => {
            console.error(
              "PostgreSQL event subscriber failed",
              error,
            );
          },
        );
      } catch (error) {
        console.error(
          "PostgreSQL event subscriber failed",
          error,
        );
      }
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

        this.#eventSubscribers.clear();

        await this.#stopEventListener();

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

  listBlockedGpuResources(...args) {
    return this.#call(
      "listBlockedGpuResources",
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

  insertSession(...args) {
    return this.#call(
      "insertSession",
      args,
    );
  }

  getSession(...args) {
    return this.#call(
      "getSession",
      args,
    );
  }

  listSessions(...args) {
    return this.#call(
      "listSessions",
      args,
    );
  }

  listRequestedSessions(...args) {
    return this.#call(
      "listRequestedSessions",
      args,
    );
  }

  listOccupyingSessions(...args) {
    return this.#call(
      "listOccupyingSessions",
      args,
    );
  }

  assignSession(...args) {
    return this.#call(
      "assignSession",
      args,
    );
  }

  startSession(...args) {
    return this.#call(
      "startSession",
      args,
    );
  }

  activateSession(...args) {
    return this.#call(
      "activateSession",
      args,
    );
  }

  renewSession(...args) {
    return this.#call(
      "renewSession",
      args,
    );
  }

  closeSession(...args) {
    return this.#call(
      "closeSession",
      args,
    );
  }

  recoverInterruptedSessions(...args) {
    return this.#call(
      "recoverInterruptedSessions",
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

    // Single SELECT statement for an internally consistent READ COMMITTED
    // snapshot without acquiring writer locks or changing any host authority.
    transaction.observeExecutionAttempt = async (input) => {
      const row = await client.query(`
        SELECT a.attempt_id AS "attemptId", a.fence_epoch AS "fenceEpoch",
          a.worker_id AS "workerId", a.gpu_uuid AS "gpuUuid",
          a.subject_kind AS "subjectKind", a.subject_id AS "subjectId",
          a.lease_id AS "leaseId", a.status AS "attemptStatus",
          f.epoch AS "currentFenceEpoch", f.safety_state AS "fenceState",
          f.attempt_id AS "fenceAttemptId", f.lease_id AS "fenceLeaseId",
          f.subject_kind AS "fenceSubjectKind", f.subject_id AS "fenceSubjectId"
        FROM execution_attempts a
        LEFT JOIN gpu_resource_fences f
          ON f.worker_id=a.worker_id AND f.gpu_uuid=a.gpu_uuid
        WHERE a.attempt_id=$1 AND a.worker_id=$2 AND a.project_id=$3
          AND a.subject_kind=$4 AND a.subject_id=$5 AND a.lease_id=$6
        LIMIT 1`,
        [input.attemptId,input.workerId,input.projectId,
          input.subjectKind,input.subjectId,input.leaseId]);
      if (!row.rows.length) return null;
      const value = row.rows[0];
      value.fenceEpoch = Number(value.fenceEpoch);
      value.currentFenceEpoch = value.currentFenceEpoch === null
        ? null : Number(value.currentFenceEpoch);
      return value;
    };

    transaction.reserveExecutionAttempt =
      (input) => postgresReserveExecutionAttempt(client, input);

    transaction.tryAcquireSchedulerLock =
      async () => {
        const result =
          await client.query(
            `
              SELECT
                pg_try_advisory_xact_lock(
                  $1::integer,
                  $2::integer
                ) AS acquired
            `,
            [
              0x4750554c,
              0x494e4b31,
            ],
          );

        return result.rows[0].acquired;
      };

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

      case "listBlockedGpuResources":
        return postgresListBlockedGpuResources(
          queryable,
          ...args,
        );

      case "listActiveJobs":
        return postgresListActiveJobs(
          queryable,
          ...args,
        );

      case "assignJob":
        return postgresAssignJob(
          queryable,
          ...args,
        );

      case "startJob":
        return postgresStartJob(
          queryable,
          ...args,
        );

      case "renewJob":
        return postgresRenewJob(
          queryable,
          ...args,
        );

      case "finishJob":
        return postgresFinishJob(
          queryable,
          ...args,
        );

      case "cancelJob":
        return postgresCancelJob(
          queryable,
          ...args,
        );

      case "recoverExpiredJobs":
        return postgresRecoverExpiredJobs(
          queryable,
          ...args,
        );

      case "insertSession":
        return postgresInsertSession(
          queryable,
          ...args,
        );

      case "getSession":
        return postgresGetSession(
          queryable,
          ...args,
        );

      case "listSessions":
        return postgresListSessions(
          queryable,
          ...args,
        );

      case "listRequestedSessions":
        return postgresListRequestedSessions(
          queryable,
          ...args,
        );

      case "listOccupyingSessions":
        return postgresListActiveSessions(
          queryable,
          ...args,
        );

      case "assignSession":
        return postgresAssignSession(
          queryable,
          ...args,
        );

      case "startSession":
        return postgresStartSession(
          queryable,
          ...args,
        );

      case "activateSession":
        return postgresActivateSession(
          queryable,
          ...args,
        );

      case "renewSession":
        return postgresRenewSession(
          queryable,
          ...args,
        );

      case "closeSession":
        return postgresCloseSession(
          queryable,
          ...args,
        );

      case "recoverInterruptedSessions":
        return postgresRecoverInterruptedSessions(
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

      case "counts":
        return postgresCounts(
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


async function postgresListBlockedGpuResources(queryable) {
  // Row locks serialize changes to existing fence rows during placement.
  // Creation of previously absent rows MUST also join the scheduler
  // advisory lock; this stage provides no live broker writers.
  const result = await queryable.query(`
    SELECT worker_id, gpu_uuid
    FROM gpu_resource_fences
    WHERE safety_state <> 'clear'
    ORDER BY worker_id, gpu_uuid
    FOR UPDATE NOWAIT
  `);
  return result.rows.map((row) => ({
    workerId: row.worker_id,
    gpuUuid: row.gpu_uuid,
  }));
}

async function postgresInsertSession(
  queryable,
  session,
) {
  const result =
    await queryable.query(
      `
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
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'requested',
          1,
          $6,
          $7::jsonb,
          $8,
          $9,
          $10::jsonb,
          $11,
          0,
          $12,
          $13,
          $14
        )
        ON CONFLICT (
          project_id,
          idempotency_key
        )
        DO NOTHING
        RETURNING *
      `,
      [
        session.id,
        session.schemaVersion,
        session.projectId,
        session.capability,
        session.priority,
        session.requirements.minVramMiB,
        JSON.stringify(
          session.requirements.capabilities,
        ),
        session.requirements.model,
        session.requirements.adapter,
        JSON.stringify(session.metadata),
        session.recovery.maxInterruptions,
        session.idempotencyKey,
        session.now,
        session.now,
      ],
    );

  if (result.rowCount > 0) {
    return {
      session:
        mapPostgresSession(
          result.rows[0],
        ),
      duplicate: false,
    };
  }

  if (session.idempotencyKey !== null) {
    const existing =
      await queryable.query(
        `
          SELECT *
          FROM sessions
          WHERE project_id = $1
            AND idempotency_key = $2
        `,
        [
          session.projectId,
          session.idempotencyKey,
        ],
      );

    if (existing.rowCount > 0) {
      return {
        session:
          mapPostgresSession(
            existing.rows[0],
          ),
        duplicate: true,
      };
    }
  }

  throw new Error(
    "PostgreSQL session insert returned no row",
  );
}

async function postgresGetSession(
  queryable,
  sessionId,
) {
  const result =
    await queryable.query(
      `
        SELECT *
        FROM sessions
        WHERE id = $1
      `,
      [sessionId],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresListSessions(
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
        FROM sessions
        ${where}
        ORDER BY created_at DESC, id ASC
        LIMIT $${parameters.length}
      `,
      parameters,
    );

  return result.rows.map(
    mapPostgresSession,
  );
}

async function postgresListRequestedSessions(
  queryable,
) {
  const result =
    await queryable.query(`
      SELECT *
      FROM sessions
      WHERE status = 'requested'
      ORDER BY
        priority DESC,
        created_at ASC,
        id ASC
    `);

  return result.rows.map(
    mapPostgresSession,
  );
}

async function postgresListActiveSessions(
  queryable,
) {
  const result =
    await queryable.query(`
      SELECT *
      FROM sessions
      WHERE status IN (
        'allocated',
        'connecting',
        'active'
      )
      ORDER BY created_at ASC, id ASC
    `);

  return result.rows.map(
    mapPostgresSession,
  );
}

function mapPostgresSession(row) {
  return {
    id: row.id,
    schemaVersion:
      Number(row.schema_version),
    projectId:
      row.project_id,
    capability:
      row.capability,
    priority:
      Number(row.priority),
    status:
      row.status,
    requirements: {
      gpuCount:
        Number(row.gpu_count),
      minVramMiB:
        Number(row.min_vram_mib),
      capabilities:
        row.required_capabilities_json ??
        [],
      model:
        row.requested_model,
      adapter:
        row.requested_adapter,
    },
    metadata:
      row.metadata_json ?? {},
    recovery: {
      maxInterruptions:
        Number(row.max_interruptions),
    },
    interruptionCount:
      Number(row.interruption_count),
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
    idempotencyKey:
      row.idempotency_key,
    createdAt:
      Number(row.created_at),
    updatedAt:
      Number(row.updated_at),
  };
}

async function postgresAssignSession(
  queryable,
  sessionId,
  placement,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE sessions
        SET
          status = 'allocated',
          assigned_worker_id = $1,
          assigned_gpu_uuid = $2,
          lease_id = $3,
          lease_expires_at = $4,
          updated_at = $5
        WHERE id = $6
          AND status = 'requested'
        RETURNING *
      `,
      [
        placement.workerId,
        placement.gpuUuid,
        leaseId,
        leaseExpiresAt,
        now,
        sessionId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresStartSession(
  queryable,
  sessionId,
  workerId,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE sessions
        SET
          status = 'connecting',
          lease_expires_at = $1,
          updated_at = $2
        WHERE id = $3
          AND status = 'allocated'
          AND assigned_worker_id = $4
          AND lease_id = $5
          AND lease_expires_at > $6
        RETURNING *
      `,
      [
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresActivateSession(
  queryable,
  sessionId,
  workerId,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE sessions
        SET
          status = 'active',
          lease_expires_at = $1,
          updated_at = $2
        WHERE id = $3
          AND status = 'connecting'
          AND assigned_worker_id = $4
          AND lease_id = $5
          AND lease_expires_at > $6
        RETURNING *
      `,
      [
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresRenewSession(
  queryable,
  sessionId,
  workerId,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE sessions
        SET
          lease_expires_at = $1,
          updated_at = $2
        WHERE id = $3
          AND status IN (
            'allocated',
            'connecting',
            'active'
          )
          AND assigned_worker_id = $4
          AND lease_id = $5
          AND lease_expires_at > $6
        RETURNING *
      `,
      [
        leaseExpiresAt,
        now,
        sessionId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresCloseSession(
  queryable,
  sessionId,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE sessions
        SET
          status = 'closed',
          assigned_worker_id = NULL,
          assigned_gpu_uuid = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = $1
        WHERE id = $2
          AND status IN (
            'requested',
            'allocated',
            'connecting',
            'active'
          )
        RETURNING *
      `,
      [
        now,
        sessionId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresSession(
        result.rows[0],
      )
    : null;
}

async function postgresRecoverInterruptedSessions(
  queryable,
  now,
  offlineWorkerIds = [],
) {
  const result =
    await queryable.query(
      `
        WITH candidates AS (
          SELECT
            id,
            status AS previous_status,
            interruption_count + 1
              AS next_interruption_count,
            CASE
              WHEN assigned_worker_id =
                ANY($2::text[])
              THEN 'heartbeat_timeout'
              ELSE 'lease_expired'
            END AS recovery_reason
          FROM sessions
          WHERE
            status IN (
              'allocated',
              'connecting',
              'active'
            )
            AND (
              (
                lease_expires_at IS NOT NULL
                AND lease_expires_at <= $1
              )
              OR assigned_worker_id =
                ANY($2::text[])
            )
          FOR UPDATE
        )
        UPDATE sessions AS session
        SET
          status =
            CASE
              WHEN
                candidates.next_interruption_count
                  <= session.max_interruptions
              THEN 'requested'
              ELSE 'interrupted'
            END,
          interruption_count =
            candidates.next_interruption_count,
          assigned_worker_id = NULL,
          assigned_gpu_uuid = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = $1
        FROM candidates
        WHERE
          session.id = candidates.id
          AND session.status IN (
            'allocated',
            'connecting',
            'active'
          )
        RETURNING
          session.*,
          candidates.recovery_reason,
          candidates.previous_status
      `,
      [
        now,
        offlineWorkerIds,
      ],
    );

  return result.rows.map(
    (row) => ({
      session:
        mapPostgresSession(row),
      reason:
        row.recovery_reason,
      previousStatus:
        row.previous_status,
    }),
  );
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

  await queryable.query(
    `
      SELECT pg_notify(
        $1,
        $2
      )
    `,
    [
      EVENT_NOTIFICATION_CHANNEL,
      String(
        inserted.rows[0].sequence,
      ),
    ],
  );

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


async function postgresAssignJob(
  queryable,
  jobId,
  placement,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE jobs
        SET
          status = 'leased',
          assigned_worker_id = $1,
          assigned_gpu_uuid = $2,
          lease_id = $3,
          lease_expires_at = $4,
          attempt = attempt + 1,
          updated_at = $5
        WHERE
          id = $6
          AND status = 'queued'
        RETURNING *
      `,
      [
        placement.workerId,
        placement.gpuUuid,
        leaseId,
        leaseExpiresAt,
        now,
        jobId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}

async function postgresStartJob(
  queryable,
  jobId,
  workerId,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE jobs
        SET
          status = 'running',
          lease_expires_at = $1,
          updated_at = $2
        WHERE
          id = $3
          AND status = 'leased'
          AND assigned_worker_id = $4
          AND lease_id = $5
          AND lease_expires_at > $6
        RETURNING *
      `,
      [
        leaseExpiresAt,
        now,
        jobId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}

async function postgresRenewJob(
  queryable,
  jobId,
  workerId,
  leaseId,
  leaseExpiresAt,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE jobs
        SET
          lease_expires_at = $1,
          updated_at = $2
        WHERE
          id = $3
          AND status = 'running'
          AND assigned_worker_id = $4
          AND lease_id = $5
          AND lease_expires_at > $6
        RETURNING *
      `,
      [
        leaseExpiresAt,
        now,
        jobId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}

async function postgresFinishJob(
  queryable,
  jobId,
  workerId,
  leaseId,
  status,
  resultValue,
  errorValue,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE jobs
        SET
          status = $1,
          result_json = $2::jsonb,
          error_json = $3::jsonb,
          lease_expires_at = NULL,
          updated_at = $4
        WHERE
          id = $5
          AND status IN (
            'leased',
            'running'
          )
          AND assigned_worker_id = $6
          AND lease_id = $7
          AND lease_expires_at > $8
        RETURNING *
      `,
      [
        status,
        resultValue === null
          ? null
          : JSON.stringify(resultValue),
        errorValue === null
          ? null
          : JSON.stringify(errorValue),
        now,
        jobId,
        workerId,
        leaseId,
        now,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}

async function postgresCancelJob(
  queryable,
  jobId,
  now,
) {
  const result =
    await queryable.query(
      `
        UPDATE jobs
        SET
          status = 'cancelled',
          lease_expires_at = NULL,
          updated_at = $1
        WHERE
          id = $2
          AND status IN (
            'queued',
            'leased',
            'running'
          )
        RETURNING *
      `,
      [
        now,
        jobId,
      ],
    );

  return result.rowCount > 0
    ? mapPostgresJob(
        result.rows[0],
      )
    : null;
}


async function postgresRecoverExpiredJobs(
  queryable,
  now,
  offlineWorkerIds = [],
) {
  const exhaustedError =
    JSON.stringify({
      code: "lease_exhausted",
      message:
        "Job exhausted its execution attempts",
    });

  const result =
    await queryable.query(
      `
        WITH candidates AS (
          SELECT
            id,
            CASE
              WHEN assigned_worker_id =
                ANY($2::text[])
              THEN 'heartbeat_timeout'
              ELSE 'lease_expired'
            END AS recovery_reason
          FROM jobs
          WHERE
            status IN (
              'leased',
              'running'
            )
            AND (
              (
                lease_expires_at
                  IS NOT NULL
                AND lease_expires_at <= $1
              )
              OR assigned_worker_id =
                ANY($2::text[])
            )
          FOR UPDATE
        )
        UPDATE jobs AS job
        SET
          status =
            CASE
              WHEN
                job.attempt >=
                job.max_attempts
              THEN 'failed'
              ELSE 'queued'
            END,
          assigned_worker_id = NULL,
          assigned_gpu_uuid = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          error_json =
            CASE
              WHEN
                job.attempt >=
                job.max_attempts
              THEN $3::jsonb
              ELSE NULL
            END,
          updated_at = $1
        FROM candidates
        WHERE
          job.id = candidates.id
          AND job.status IN (
            'leased',
            'running'
          )
        RETURNING
          job.*,
          candidates.recovery_reason
      `,
      [
        now,
        offlineWorkerIds,
        exhaustedError,
      ],
    );

  return result.rows.map(
    (row) => ({
      job:
        mapPostgresJob(row),
      reason:
        row.recovery_reason,
    }),
  );
}

async function postgresCounts(
  queryable,
) {
  const workers =
    await queryable.query(`
      SELECT
        status,
        COUNT(*) AS count
      FROM workers
      GROUP BY status
    `);

  const jobs =
    await queryable.query(`
      SELECT
        status,
        COUNT(*) AS count
      FROM jobs
      GROUP BY status
    `);

  const workerCounts =
    Object.fromEntries(
      workers.rows.map(
        (row) => [
          row.status,
          Number(row.count),
        ],
      ),
    );

  const jobCounts =
    Object.fromEntries(
      jobs.rows.map(
        (row) => [
          row.status,
          Number(row.count),
        ],
      ),
    );

  return {
    workerCounts,
    jobCounts,
  };
}

// B2C2B2B: The SAME advisory lock used by the scheduler protects *missing*
// fence rows, not just existing rows. The worker and logical owner are locked
// against concurrent updates. All modifications rollback on any rejection.
async function postgresReserveExecutionAttempt(client, rawInput) {
  const input = validateExecutionClaim(rawInput);
  const lock = await client.query(`SELECT pg_try_advisory_xact_lock(
    1196447052::integer, 1229867825::integer) AS acquired`);
  if (!lock.rows[0].acquired) throw new ExecutionClaimDenied("allocation_busy");
  const wr = await client.query('SELECT * FROM workers WHERE id=$1 FOR UPDATE',
    [input.workerId]);
  const table = input.subjectKind === 'job' ? 'jobs' : 'sessions';
  const owned = await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,
    [input.subjectId]);
  const worker = wr.rows.length ? {
    status:wr.rows[0].status, drainMode: Boolean(wr.rows[0].drain_mode),
    lastSeenAt:Number(wr.rows[0].last_seen_at),
    gpus:typeof wr.rows[0].gpu_inventory_json === 'string'
      ? JSON.parse(wr.rows[0].gpu_inventory_json)
      : wr.rows[0].gpu_inventory_json,
  } : null;
  const workload = owned.rows.length ? {
    status:owned.rows[0].status, leaseId:owned.rows[0].lease_id,
    assignedWorkerId:owned.rows[0].assigned_worker_id,
    assignedGpuUuid:owned.rows[0].assigned_gpu_uuid,
    leaseExpiresAt:owned.rows[0].lease_expires_at===null?null:Number(owned.rows[0].lease_expires_at),
    projectId:owned.rows[0].project_id,
  } : null;
  validateCurrentExecutionOwner(input,worker,workload);
  const conflict = await client.query(`
    SELECT 1 FROM jobs WHERE assigned_worker_id=$1 AND assigned_gpu_uuid=$2
      AND status IN ('leased','running') AND id<>$3
    UNION ALL SELECT 1 FROM sessions WHERE assigned_worker_id=$1 AND assigned_gpu_uuid=$2
      AND status IN ('allocated','connecting','active') AND id<>$4
    LIMIT 1`,[input.workerId,input.gpuUuid,
      input.subjectKind==='job'?input.subjectId:'',
      input.subjectKind==='session'?input.subjectId:'']);
  if (conflict.rowCount) throw new ExecutionClaimDenied("resource_conflict");
  const row = await client.query(`
    INSERT INTO gpu_resource_fences
      (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,attempt_id,updated_at)
    VALUES ($1,$2,1,'reserved',$3,$4,$5,$6,$7)
    ON CONFLICT(worker_id,gpu_uuid) DO UPDATE SET
      epoch=gpu_resource_fences.epoch+1,
      safety_state='reserved',subject_kind=EXCLUDED.subject_kind,
      subject_id=EXCLUDED.subject_id,lease_id=EXCLUDED.lease_id,
      attempt_id=EXCLUDED.attempt_id,updated_at=EXCLUDED.updated_at
    WHERE gpu_resource_fences.safety_state='clear'
    RETURNING epoch`,[input.workerId,input.gpuUuid,input.subjectKind,
      input.subjectId,input.leaseId,input.attemptId,input.now]);
  if (!row.rowCount) throw new ExecutionClaimDenied("resource_held");
  const epoch=Number(row.rows[0].epoch);
  await client.query(`INSERT INTO execution_attempts
    (attempt_id,subject_kind,subject_id,project_id,lease_id,worker_id,gpu_uuid,
    fence_epoch,artifact_digest,adapter_identity,runtime_policy_revision,
    approval_ref,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',$13,$13)`,
    [input.attemptId,input.subjectKind,input.subjectId,workload.projectId,
      input.leaseId,input.workerId,input.gpuUuid,epoch,input.artifactDigest,
      input.adapterIdentity,input.runtimePolicyRevision,input.approvalRef,input.now]);
  return {attemptId:input.attemptId,fenceEpoch:epoch,canLaunch:false};
}
