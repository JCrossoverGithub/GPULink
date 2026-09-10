import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  assertPersistenceContract,
} from "../src/control-plane/persistence/contract.mjs";
import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";
import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";

const { Pool } = pg;

const connectionString =
  process.env.GPULINK_TEST_POSTGRES_URL;

test(
  "PostgreSQL persistence initializes schema and transaction lifecycle",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const database =
      new PostgresPersistence(
        connectionString,
        {
          maxConnections: 2,
        },
      );

    const inspector =
      new Pool({
        connectionString,
        max: 1,
      });

    try {
      assert.equal(
        assertPersistenceContract(
          database,
        ),
        database,
      );

      const first =
        await database.initialize();

      const second =
        await database.initialize();

      assert.equal(first, database);
      assert.equal(second, database);

      const result =
        await database.transaction(
          async (transaction) => {
            assert.equal(
              typeof transaction.getJob,
              "function",
            );

            assert.equal(
              typeof transaction.appendEvent,
              "function",
            );

            return {
              committed: true,
            };
          },
        );

      assert.deepEqual(
        result,
        {
          committed: true,
        },
      );

      await assert.rejects(
        database.transaction(
          async () => {
            throw new Error(
              "intentional rollback",
            );
          },
        ),
        /intentional rollback/u,
      );

      const tables =
        await inspector.query(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'gpulink_schema_migrations',
              'workers',
              'jobs',
              'events'
            )
          ORDER BY table_name
        `);

      assert.deepEqual(
        tables.rows.map(
          (row) => row.table_name,
        ),
        [
          "events",
          "gpulink_schema_migrations",
          "jobs",
          "workers",
        ],
      );

      const migrations =
        await inspector.query(`
          SELECT filename, checksum
          FROM gpulink_schema_migrations
          ORDER BY filename
        `);

      assert.equal(
        migrations.rowCount,
        1,
      );

      assert.equal(
        migrations.rows[0].filename,
        "0001-initial.sql",
      );

      assert.match(
        migrations.rows[0].checksum,
        /^[0-9a-f]{64}$/u,
      );

      await assert.rejects(
        database.counts(),
        /counts is not implemented/u,
      );
    } finally {
      await inspector.end();
      await database.close();
      await database.close();
    }
  },
);


test(
  "PostgreSQL worker persistence matches SQLite semantics",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const postgres =
      new PostgresPersistence(
        connectionString,
        {
          maxConnections: 2,
        },
      );

    const sqlite =
      new SqlitePersistence(
        ":memory:",
      );

    const inspector =
      new Pool({
        connectionString,
        max: 1,
      });

    try {
      await postgres.initialize();

      await inspector.query(`
        TRUNCATE TABLE
          events,
          jobs,
          workers
        RESTART IDENTITY CASCADE
      `);

      const initialNow =
        1_700_000_000_000;

      const worker = {
        id:
          "worker-postgres-parity",
        name:
          "postgres-parity-worker",
        version:
          "1.0.0",
        baseUrl:
          "http://worker.test",
        labels: {
          location: "lab",
          tier: "test",
        },
        capabilities: [
          "diagnostic.echo",
        ],
        adapterManifests: [
          {
            schemaVersion: 1,
            type:
              "diagnostic.echo",
            version:
              "1.0.0",
            executionMode:
              "in-process",
          },
        ],
        adapterHealth: [
          {
            schemaVersion: 1,
            type:
              "diagnostic.echo",
            state: "ready",
            code: "ready",
            checkedAt:
              initialNow,
          },
        ],
        warmModels: [
          "example/warm-model",
        ],
        modelInventory: [
          {
            schemaVersion: 1,
            modelId:
              "example/cached-model",
            revision: "main",
            adapterType:
              "diagnostic.echo",
          },
        ],
        gpus: [
          {
            uuid:
              "GPU-POSTGRES-PARITY",
            index: 0,
            name:
              "PostgreSQL Test GPU",
            memoryTotalMiB:
              24576,
            memoryUsedMiB:
              1024,
            utilizationPercent:
              20,
            temperatureC:
              45,
            powerDrawWatts:
              100.5,
          },
        ],
        now: initialNow,
      };

      const postgresInserted =
        await postgres.transaction(
          (transaction) =>
            transaction.upsertWorker(
              worker,
            ),
        );

      const sqliteInserted =
        await sqlite.transaction(
          (transaction) =>
            transaction.upsertWorker(
              worker,
            ),
        );

      assert.deepEqual(
        postgresInserted,
        sqliteInserted,
      );

      assert.deepEqual(
        await postgres.getWorker(
          worker.id,
        ),
        await sqlite.getWorker(
          worker.id,
        ),
      );

      assert.deepEqual(
        await postgres.listWorkers(),
        await sqlite.listWorkers(),
      );

      const drainNow =
        initialNow + 100;

      assert.deepEqual(
        await postgres.setWorkerDrain(
          worker.id,
          true,
          drainNow,
        ),
        await sqlite.setWorkerDrain(
          worker.id,
          true,
          drainNow,
        ),
      );

      const reregisterNow =
        initialNow + 200;

      const reregisteredWorker = {
        ...worker,
        id:
          "worker-replacement-id",
        version:
          "2.0.0",
        labels: {
          location: "lab",
          tier: "updated",
        },
        now:
          reregisterNow,
      };

      const postgresReregistered =
        await postgres.upsertWorker(
          reregisteredWorker,
        );

      const sqliteReregistered =
        await sqlite.upsertWorker(
          reregisteredWorker,
        );

      assert.deepEqual(
        postgresReregistered,
        sqliteReregistered,
      );

      assert.equal(
        postgresReregistered.id,
        worker.id,
      );

      assert.equal(
        postgresReregistered.drainMode,
        true,
      );

      assert.equal(
        postgresReregistered.createdAt,
        initialNow,
      );

      const heartbeatNow =
        initialNow + 300;

      const heartbeat = {
        capabilities: [
          "diagnostic.echo",
          "benchmark.gpu",
        ],
        adapterManifests: [
          {
            schemaVersion: 1,
            type:
              "diagnostic.echo",
            version:
              "1.0.1",
            executionMode:
              "in-process",
          },
        ],
        adapterHealth: [
          {
            schemaVersion: 1,
            type:
              "diagnostic.echo",
            state: "ready",
            code: "ready",
            checkedAt:
              heartbeatNow,
          },
        ],
        warmModels: [],
        modelInventory: [],
        gpus: [
          {
            uuid:
              "GPU-POSTGRES-PARITY",
            index: 0,
            name:
              "PostgreSQL Test GPU",
            memoryTotalMiB:
              24576,
            memoryUsedMiB:
              2048,
            utilizationPercent:
              30,
            temperatureC:
              48,
            powerDrawWatts:
              125.25,
          },
        ],
        now:
          heartbeatNow,
      };

      assert.deepEqual(
        await postgres
          .updateWorkerHeartbeat(
            worker.id,
            heartbeat,
          ),
        await sqlite
          .updateWorkerHeartbeat(
            worker.id,
            heartbeat,
          ),
      );

      const offlineNow =
        initialNow + 400;

      const staleBefore =
        heartbeatNow + 1;

      assert.deepEqual(
        await postgres
          .markStaleWorkersOffline(
            staleBefore,
            offlineNow,
          ),
        await sqlite
          .markStaleWorkersOffline(
            staleBefore,
            offlineNow,
          ),
      );

      const postgresFinal =
        await postgres.getWorker(
          worker.id,
        );

      const sqliteFinal =
        await sqlite.getWorker(
          worker.id,
        );

      assert.deepEqual(
        postgresFinal,
        sqliteFinal,
      );

      assert.equal(
        postgresFinal.status,
        "offline",
      );

      assert.equal(
        postgresFinal.drainMode,
        true,
      );

      assert.equal(
        await postgres.getWorker(
          "worker-does-not-exist",
        ),
        null,
      );

      assert.equal(
        await postgres
          .updateWorkerHeartbeat(
            "worker-does-not-exist",
            heartbeat,
          ),
        null,
      );

      assert.equal(
        await postgres.setWorkerDrain(
          "worker-does-not-exist",
          true,
          offlineNow,
        ),
        null,
      );
    } finally {
      try {
        await inspector.query(`
          TRUNCATE TABLE
            events,
            jobs,
            workers
          RESTART IDENTITY CASCADE
        `);
      } finally {
        await inspector.end();
        await postgres.close();
        await sqlite.close();
      }
    }
  },
);
