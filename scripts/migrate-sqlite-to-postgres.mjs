#!/usr/bin/env node

import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
} from "node:sqlite";
import {
  pathToFileURL,
} from "node:url";

import pg from "pg";

import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";

const { Client } = pg;

const REQUIRED_COLUMNS = Object.freeze({
  workers: Object.freeze([
    "id",
    "name",
    "version",
    "base_url",
    "status",
    "drain_mode",
    "labels_json",
    "capabilities_json",
    "adapter_manifests_json",
    "adapter_health_json",
    "warm_models_json",
    "model_inventory_json",
    "gpu_inventory_json",
    "last_seen_at",
    "created_at",
    "updated_at",
  ]),

  jobs: Object.freeze([
    "id",
    "project_id",
    "type",
    "priority",
    "status",
    "gpu_count",
    "min_vram_mib",
    "required_capabilities_json",
    "requested_model",
    "payload_json",
    "result_json",
    "error_json",
    "assigned_worker_id",
    "assigned_gpu_uuid",
    "lease_id",
    "lease_expires_at",
    "attempt",
    "max_attempts",
    "idempotency_key",
    "created_at",
    "updated_at",
  ]),

  events: Object.freeze([
    "sequence",
    "type",
    "subject_id",
    "payload_json",
    "created_at",
  ]),
});

export async function migrateSqliteToPostgres({
  sourcePath,
  connectionString,
  apply = false,
}) {
  const resolvedSourcePath =
    validateSourcePath(sourcePath);

  if (
    typeof connectionString !== "string" ||
    connectionString.trim() === ""
  ) {
    throw new Error(
      "GPULINK_DATABASE_URL must contain the PostgreSQL connection string",
    );
  }

  assertNoActiveWal(
    resolvedSourcePath,
  );

  const sourceDatabase =
    new DatabaseSync(
      resolvedSourcePath,
      {
        readOnly: true,
      },
    );

  let sourceData;

  try {
    validateSqliteSource(
      sourceDatabase,
    );

    sourceData =
      readSqliteData(
        sourceDatabase,
      );
  } finally {
    sourceDatabase.close();
  }

  const sourceSummary =
    summarizeData(
      sourceData,
    );

  const targetBefore =
    await inspectPostgresTarget(
      connectionString,
    );

  if (targetBefore.partialSchema) {
    throw new Error(
      `PostgreSQL target contains a partial GPULink schema: ${targetBefore.presentTables.join(", ")}`,
    );
  }

  if (!apply) {
    return {
      mode: "dry-run",
      sourcePath:
        resolvedSourcePath,
      source:
        sourceSummary,
      target:
        targetBefore,
      readyToApply:
        targetBefore.empty,
    };
  }

  if (!targetBefore.empty) {
    throw new Error(
      "PostgreSQL target is not empty; migration refused",
    );
  }

  await initializePostgres(
    connectionString,
  );

  const client =
    new Client({
      connectionString,
    });

  await client.connect();

  try {
    await client.query("BEGIN");

    /*
     * Nothing else may begin writing GPULink
     * state while the authoritative import is
     * underway.
     */
    await client.query(`
      LOCK TABLE
        workers,
        jobs,
        events
      IN ACCESS EXCLUSIVE MODE
    `);

    const targetReady =
      await inspectPostgresTargetWithClient(
        client,
      );

    if (
      !targetReady.schemaReady ||
      targetReady.partialSchema
    ) {
      throw new Error(
        "PostgreSQL GPULink schema is not ready after initialization",
      );
    }

    if (!targetReady.empty) {
      throw new Error(
        "PostgreSQL target became non-empty before migration; migration refused",
      );
    }

    for (const worker of sourceData.workers) {
      await insertWorker(
        client,
        worker,
      );
    }

    for (const job of sourceData.jobs) {
      await insertJob(
        client,
        job,
      );
    }

    for (const event of sourceData.events) {
      await insertEvent(
        client,
        event,
      );
    }

    await reseedEventIdentity(
      client,
    );

    const targetData =
      await readPostgresData(
        client,
      );

    const targetSummary =
      summarizeData(
        targetData,
      );

    verifyMigration(
      sourceSummary,
      targetSummary,
    );

    await client.query("COMMIT");

    return {
      mode: "apply",
      sourcePath:
        resolvedSourcePath,
      source:
        sourceSummary,
      targetBefore,
      targetAfter:
        targetSummary,
      verified: true,
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK",
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [
          error,
          rollbackError,
        ],
        "SQLite to PostgreSQL migration rollback failed",
      );
    }

    throw error;
  } finally {
    await client.end();
  }
}

function validateSourcePath(
  sourcePath,
) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.trim() === ""
  ) {
    throw new Error(
      "SQLite source path is required",
    );
  }

  const resolved =
    path.resolve(
      sourcePath,
    );

  if (!existsSync(resolved)) {
    throw new Error(
      `SQLite source does not exist: ${resolved}`,
    );
  }

  const status =
    statSync(resolved);

  if (!status.isFile()) {
    throw new Error(
      `SQLite source is not a regular file: ${resolved}`,
    );
  }

  return resolved;
}

function assertNoActiveWal(
  sourcePath,
) {
  const walPath =
    `${sourcePath}-wal`;

  if (
    existsSync(walPath) &&
    statSync(walPath).size > 0
  ) {
    throw new Error(
      "SQLite source has a non-empty WAL sidecar. Stop the source control plane and create a clean SQLite snapshot before migration.",
    );
  }
}

function validateSqliteSource(
  database,
) {
  const integrity =
    database
      .prepare(
        "PRAGMA integrity_check",
      )
      .all();

  if (
    integrity.length !== 1 ||
    integrity[0]
      .integrity_check !== "ok"
  ) {
    throw new Error(
      "SQLite integrity_check failed",
    );
  }

  const foreignKeyViolations =
    database
      .prepare(
        "PRAGMA foreign_key_check",
      )
      .all();

  if (
    foreignKeyViolations.length > 0
  ) {
    throw new Error(
      `SQLite foreign_key_check found ${foreignKeyViolations.length} violation(s)`,
    );
  }

  for (
    const [
      table,
      requiredColumns,
    ] of Object.entries(
      REQUIRED_COLUMNS,
    )
  ) {
    const columns =
      new Set(
        database
          .prepare(
            `PRAGMA table_info(${table})`,
          )
          .all()
          .map(
            (column) =>
              column.name,
          ),
      );

    const missing =
      requiredColumns.filter(
        (column) =>
          !columns.has(column),
      );

    if (missing.length > 0) {
      throw new Error(
        `SQLite table ${table} is missing required columns: ${missing.join(", ")}`,
      );
    }
  }
}

function readSqliteData(
  database,
) {
  return {
    workers:
      database
        .prepare(`
          SELECT *
          FROM workers
          ORDER BY id
        `)
        .all()
        .map(
          mapSqliteWorker,
        ),

    jobs:
      database
        .prepare(`
          SELECT *
          FROM jobs
          ORDER BY id
        `)
        .all()
        .map(
          mapSqliteJob,
        ),

    events:
      database
        .prepare(`
          SELECT *
          FROM events
          ORDER BY sequence
        `)
        .all()
        .map(
          mapSqliteEvent,
        ),
  };
}

function mapSqliteWorker(
  row,
) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    baseUrl:
      row.base_url,
    status:
      row.status,
    drainMode:
      Boolean(
        row.drain_mode,
      ),
    labels:
      parseJson(
        row.labels_json,
        {},
      ),
    capabilities:
      parseJson(
        row.capabilities_json,
        [],
      ),
    adapterManifests:
      parseJson(
        row.adapter_manifests_json,
        [],
      ),
    adapterHealth:
      parseJson(
        row.adapter_health_json,
        [],
      ),
    warmModels:
      parseJson(
        row.warm_models_json,
        [],
      ),
    modelInventory:
      parseJson(
        row.model_inventory_json,
        [],
      ),
    gpus:
      parseJson(
        row.gpu_inventory_json,
        [],
      ),
    lastSeenAt:
      Number(
        row.last_seen_at,
      ),
    createdAt:
      Number(
        row.created_at,
      ),
    updatedAt:
      Number(
        row.updated_at,
      ),
  };
}

function mapSqliteJob(
  row,
) {
  return {
    id:
      row.id,
    projectId:
      row.project_id,
    type:
      row.type,
    priority:
      Number(
        row.priority,
      ),
    status:
      row.status,
    gpuCount:
      Number(
        row.gpu_count,
      ),
    minVramMiB:
      Number(
        row.min_vram_mib,
      ),
    requiredCapabilities:
      parseJson(
        row.required_capabilities_json,
        [],
      ),
    requestedModel:
      row.requested_model,
    payload:
      parseJson(
        row.payload_json,
        {},
      ),
    result:
      parseJson(
        row.result_json,
        null,
      ),
    error:
      parseJson(
        row.error_json,
        null,
      ),
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
      Number(
        row.attempt,
      ),
    maxAttempts:
      Number(
        row.max_attempts,
      ),
    idempotencyKey:
      row.idempotency_key,
    createdAt:
      Number(
        row.created_at,
      ),
    updatedAt:
      Number(
        row.updated_at,
      ),
  };
}

function mapSqliteEvent(
  row,
) {
  return {
    sequence:
      Number(
        row.sequence,
      ),
    type:
      row.type,
    subjectId:
      row.subject_id,
    payload:
      parseJson(
        row.payload_json,
        {},
      ),
    createdAt:
      Number(
        row.created_at,
      ),
  };
}

function parseJson(
  value,
  fallback,
) {
  if (value === null) {
    return fallback;
  }

  return JSON.parse(value);
}

async function inspectPostgresTarget(
  connectionString,
) {
  const client =
    new Client({
      connectionString,
    });

  await client.connect();

  try {
    return await inspectPostgresTargetWithClient(
      client,
    );
  } finally {
    await client.end();
  }
}

async function inspectPostgresTargetWithClient(
  client,
) {
  const result =
    await client.query(`
      SELECT
        to_regclass(
          'public.gpulink_schema_migrations'
        ) AS migrations,
        to_regclass(
          'public.workers'
        ) AS workers,
        to_regclass(
          'public.jobs'
        ) AS jobs,
        to_regclass(
          'public.events'
        ) AS events
    `);

  const row =
    result.rows[0];

  const tablePresence = {
    gpulink_schema_migrations:
      row.migrations !== null,
    workers:
      row.workers !== null,
    jobs:
      row.jobs !== null,
    events:
      row.events !== null,
  };

  const presentTables =
    Object.entries(
      tablePresence,
    )
      .filter(
        ([, present]) =>
          present,
      )
      .map(
        ([name]) =>
          name,
      );

  const presentCount =
    presentTables.length;

  if (presentCount === 0) {
    return {
      schemaReady: false,
      partialSchema: false,
      presentTables: [],
      empty: true,
      summary: null,
    };
  }

  if (
    presentCount !==
    Object.keys(
      tablePresence,
    ).length
  ) {
    return {
      schemaReady: false,
      partialSchema: true,
      presentTables,
      empty: false,
      summary: null,
    };
  }

  const data =
    await readPostgresData(
      client,
    );

  const summary =
    summarizeData(
      data,
    );

  return {
    schemaReady: true,
    partialSchema: false,
    presentTables,
    empty:
      summary.counts.workers === 0 &&
      summary.counts.jobs === 0 &&
      summary.counts.events === 0,
    summary,
  };
}

async function initializePostgres(
  connectionString,
) {
  const database =
    new PostgresPersistence(
      connectionString,
    );

  try {
    await database.initialize();
  } finally {
    await database.close();
  }
}

async function readPostgresData(
  client,
) {
  const workers =
    await client.query(`
      SELECT *
      FROM workers
      ORDER BY id
    `);

  const jobs =
    await client.query(`
      SELECT *
      FROM jobs
      ORDER BY id
    `);

  const events =
    await client.query(`
      SELECT *
      FROM events
      ORDER BY sequence
    `);

  return {
    workers:
      workers.rows.map(
        mapPostgresWorker,
      ),
    jobs:
      jobs.rows.map(
        mapPostgresJob,
      ),
    events:
      events.rows.map(
        mapPostgresEvent,
      ),
  };
}

function mapPostgresWorker(
  row,
) {
  return {
    id:
      row.id,
    name:
      row.name,
    version:
      row.version,
    baseUrl:
      row.base_url,
    status:
      row.status,
    drainMode:
      Boolean(
        row.drain_mode,
      ),
    labels:
      row.labels_json ?? {},
    capabilities:
      row.capabilities_json ?? [],
    adapterManifests:
      row.adapter_manifests_json ??
      [],
    adapterHealth:
      row.adapter_health_json ??
      [],
    warmModels:
      row.warm_models_json ??
      [],
    modelInventory:
      row.model_inventory_json ??
      [],
    gpus:
      row.gpu_inventory_json ??
      [],
    lastSeenAt:
      Number(
        row.last_seen_at,
      ),
    createdAt:
      Number(
        row.created_at,
      ),
    updatedAt:
      Number(
        row.updated_at,
      ),
  };
}

function mapPostgresJob(
  row,
) {
  return {
    id:
      row.id,
    projectId:
      row.project_id,
    type:
      row.type,
    priority:
      Number(
        row.priority,
      ),
    status:
      row.status,
    gpuCount:
      Number(
        row.gpu_count,
      ),
    minVramMiB:
      Number(
        row.min_vram_mib,
      ),
    requiredCapabilities:
      row.required_capabilities_json ??
      [],
    requestedModel:
      row.requested_model,
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
      Number(
        row.attempt,
      ),
    maxAttempts:
      Number(
        row.max_attempts,
      ),
    idempotencyKey:
      row.idempotency_key,
    createdAt:
      Number(
        row.created_at,
      ),
    updatedAt:
      Number(
        row.updated_at,
      ),
  };
}

function mapPostgresEvent(
  row,
) {
  return {
    sequence:
      Number(
        row.sequence,
      ),
    type:
      row.type,
    subjectId:
      row.subject_id,
    payload:
      row.payload_json ?? {},
    createdAt:
      Number(
        row.created_at,
      ),
  };
}

async function insertWorker(
  client,
  worker,
) {
  await client.query(
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
        $5,
        $6,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        $13::jsonb,
        $14,
        $15,
        $16
      )
    `,
    [
      worker.id,
      worker.name,
      worker.version,
      worker.baseUrl,
      worker.status,
      worker.drainMode,
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
      worker.lastSeenAt,
      worker.createdAt,
      worker.updatedAt,
    ],
  );
}

async function insertJob(
  client,
  job,
) {
  await client.query(
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
        result_json,
        error_json,
        assigned_worker_id,
        assigned_gpu_uuid,
        lease_id,
        lease_expires_at,
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
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21
      )
    `,
    [
      job.id,
      job.projectId,
      job.type,
      job.priority,
      job.status,
      job.gpuCount,
      job.minVramMiB,
      JSON.stringify(
        job.requiredCapabilities,
      ),
      job.requestedModel,
      JSON.stringify(
        job.payload,
      ),
      job.result === null
        ? null
        : JSON.stringify(
            job.result,
          ),
      job.error === null
        ? null
        : JSON.stringify(
            job.error,
          ),
      job.assignedWorkerId,
      job.assignedGpuUuid,
      job.leaseId,
      job.leaseExpiresAt,
      job.attempt,
      job.maxAttempts,
      job.idempotencyKey,
      job.createdAt,
      job.updatedAt,
    ],
  );
}

async function insertEvent(
  client,
  event,
) {
  await client.query(
    `
      INSERT INTO events (
        sequence,
        type,
        subject_id,
        payload_json,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5
      )
    `,
    [
      event.sequence,
      event.type,
      event.subjectId,
      JSON.stringify(
        event.payload,
      ),
      event.createdAt,
    ],
  );
}

async function reseedEventIdentity(
  client,
) {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence(
        'events',
        'sequence'
      )::regclass,
      COALESCE(
        (
          SELECT MAX(sequence)
          FROM events
        ),
        1
      ),
      EXISTS(
        SELECT 1
        FROM events
      )
    )
  `);
}

function summarizeData(
  data,
) {
  return {
    counts: {
      workers:
        data.workers.length,
      jobs:
        data.jobs.length,
      events:
        data.events.length,
    },

    workerStatuses:
      countBy(
        data.workers,
        "status",
      ),

    jobStatuses:
      countBy(
        data.jobs,
        "status",
      ),

    maxEventSequence:
      data.events.length === 0
        ? null
        : Math.max(
            ...data.events.map(
              (event) =>
                event.sequence,
            ),
          ),

    fingerprints: {
      workers:
        fingerprint(
          data.workers,
        ),
      jobs:
        fingerprint(
          data.jobs,
        ),
      events:
        fingerprint(
          data.events,
        ),
    },
  };
}

function countBy(
  rows,
  property,
) {
  const counts =
    new Map();

  for (const row of rows) {
    counts.set(
      row[property],
      (
        counts.get(
          row[property],
        ) ?? 0
      ) + 1,
    );
  }

  return Object.fromEntries(
    [...counts.entries()]
      .sort(
        ([left], [right]) =>
          left.localeCompare(
            right,
          ),
      ),
  );
}

function fingerprint(
  rows,
) {
  return createHash("sha256")
    .update(
      stableStringify(
        rows,
      ),
    )
    .digest("hex");
}

function stableStringify(
  value,
) {
  return JSON.stringify(
    canonicalize(value),
  );
}

function canonicalize(
  value,
) {
  if (Array.isArray(value)) {
    return value.map(
      canonicalize,
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(
          (key) => [
            key,
            canonicalize(
              value[key],
            ),
          ],
        ),
    );
  }

  return value;
}

function verifyMigration(
  source,
  target,
) {
  const fields = [
    "counts",
    "workerStatuses",
    "jobStatuses",
    "maxEventSequence",
    "fingerprints",
  ];

  for (const field of fields) {
    if (
      stableStringify(
        source[field],
      ) !==
      stableStringify(
        target[field],
      )
    ) {
      throw new Error(
        `Migration verification failed for ${field}`,
      );
    }
  }
}

function parseArguments(
  argumentsList,
) {
  let sourcePath = null;
  let apply = false;
  let help = false;

  for (
    const argument of
    argumentsList
  ) {
    if (
      argument === "--apply"
    ) {
      apply = true;
      continue;
    }

    if (
      argument === "--help" ||
      argument === "-h"
    ) {
      help = true;
      continue;
    }

    if (
      argument.startsWith("-")
    ) {
      throw new Error(
        `Unknown option ${argument}`,
      );
    }

    if (sourcePath !== null) {
      throw new Error(
        "Only one SQLite source path may be supplied",
      );
    }

    sourcePath =
      argument;
  }

  return {
    sourcePath,
    apply,
    help,
  };
}

function usage() {
  return [
    "Usage:",
    "  npm run migrate:sqlite-to-postgres -- <sqlite-snapshot>",
    "  npm run migrate:sqlite-to-postgres -- <sqlite-snapshot> --apply",
    "",
    "Environment:",
    "  GPULINK_DATABASE_URL   PostgreSQL connection string",
    "",
    "The command defaults to dry-run mode.",
    "Use --apply only after reviewing the dry-run summary.",
    "",
    "The SQLite source must be a clean snapshot from a stopped control plane.",
  ].join("\n");
}

async function main() {
  const {
    sourcePath,
    apply,
    help,
  } =
    parseArguments(
      process.argv.slice(2),
    );

  if (help) {
    console.log(
      usage(),
    );
    return;
  }

  if (!sourcePath) {
    throw new Error(
      `${usage()}\n\nSQLite source path is required`,
    );
  }

  const connectionString =
    process.env
      .GPULINK_DATABASE_URL
      ?.trim();

  const result =
    await migrateSqliteToPostgres({
      sourcePath,
      connectionString,
      apply,
    });

  console.log(
    JSON.stringify(
      result,
      null,
      2,
    ),
  );
}

const invokedUrl =
  process.argv[1]
    ? pathToFileURL(
        path.resolve(
          process.argv[1],
        ),
      ).href
    : null;

if (
  invokedUrl === import.meta.url
) {
  main().catch(
    (error) => {
      console.error(
        error instanceof Error
          ? error.message
          : error,
      );

      process.exitCode = 1;
    },
  );
}
