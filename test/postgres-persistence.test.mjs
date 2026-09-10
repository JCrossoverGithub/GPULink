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

test(
  "PostgreSQL event persistence matches SQLite semantics and transaction rollback",
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

      const firstNow =
        1_700_000_000_000;

      const postgresFirst =
        await postgres.appendEvent(
          "worker.online",
          "worker-event-test",
          {
            name: "event-worker",
            gpuCount: 1,
          },
          firstNow,
        );

      const sqliteFirst =
        await sqlite.appendEvent(
          "worker.online",
          "worker-event-test",
          {
            name: "event-worker",
            gpuCount: 1,
          },
          firstNow,
        );

      assert.deepEqual(
        postgresFirst,
        sqliteFirst,
      );

      const secondNow =
        firstNow + 100;

      const postgresSecond =
        await postgres.appendEvent(
          "job.queued",
          "job-event-test",
          {
            projectId: "test",
            priority: 10,
          },
          secondNow,
        );

      const sqliteSecond =
        await sqlite.appendEvent(
          "job.queued",
          "job-event-test",
          {
            projectId: "test",
            priority: 10,
          },
          secondNow,
        );

      assert.deepEqual(
        postgresSecond,
        sqliteSecond,
      );

      assert.deepEqual(
        await postgres.listEventsAfter(0),
        await sqlite.listEventsAfter(0),
      );

      assert.deepEqual(
        await postgres.listEventsAfter(
          postgresFirst.sequence,
        ),
        await sqlite.listEventsAfter(
          sqliteFirst.sequence,
        ),
      );

      assert.deepEqual(
        await postgres.listEventsAfter(
          0,
          1,
        ),
        await sqlite.listEventsAfter(
          0,
          1,
        ),
      );

      await assert.rejects(
        postgres.transaction(
          async (transaction) => {
            await transaction.appendEvent(
              "job.failed",
              "job-rollback-test",
              {
                reason:
                  "intentional_test",
              },
              secondNow + 100,
            );

            throw new Error(
              "rollback event transaction",
            );
          },
        ),
        /rollback event transaction/u,
      );

      const afterRollback =
        await postgres.listEventsAfter(0);

      assert.deepEqual(
        afterRollback,
        await sqlite.listEventsAfter(0),
      );

      assert.equal(
        afterRollback.some(
          (event) =>
            event.subjectId ===
            "job-rollback-test",
        ),
        false,
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

test(
  "PostgreSQL basic job persistence matches SQLite semantics",
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

      const firstJob = {
        id: "job-postgres-basic-1",
        projectId: "postgres-test",
        type: "diagnostic.echo",
        priority: 5,
        minVramMiB: 4096,
        requiredCapabilities: [
          "diagnostic.echo",
        ],
        requestedModel: null,
        payload: {
          echo: "first",
        },
        maxAttempts: 3,
        idempotencyKey:
          "request-basic-1",
        now:
          1_700_000_000_000,
      };

      const secondJob = {
        id: "job-postgres-basic-2",
        projectId: "postgres-test",
        type: "benchmark.gpu",
        priority: 10,
        minVramMiB: 8192,
        requiredCapabilities: [
          "benchmark.gpu",
        ],
        requestedModel:
          "example/model",
        payload: {
          schemaVersion: 1,
        },
        maxAttempts: 2,
        idempotencyKey: null,
        now:
          1_700_000_000_100,
      };

      const postgresFirst =
        await postgres.insertJob(
          firstJob,
        );

      const sqliteFirst =
        await sqlite.insertJob(
          firstJob,
        );

      assert.deepEqual(
        postgresFirst,
        sqliteFirst,
      );

      const postgresSecond =
        await postgres.insertJob(
          secondJob,
        );

      const sqliteSecond =
        await sqlite.insertJob(
          secondJob,
        );

      assert.deepEqual(
        postgresSecond,
        sqliteSecond,
      );

      assert.deepEqual(
        await postgres.getJob(
          firstJob.id,
        ),
        await sqlite.getJob(
          firstJob.id,
        ),
      );

      assert.equal(
        await postgres.getJob(
          "job-does-not-exist",
        ),
        null,
      );

      assert.deepEqual(
        await postgres.listJobs(),
        await sqlite.listJobs(),
      );

      assert.deepEqual(
        await postgres.listJobs({
          status: "queued",
          limit: 1,
        }),
        await sqlite.listJobs({
          status: "queued",
          limit: 1,
        }),
      );

      assert.deepEqual(
        await postgres.listJobs({
          workerId:
            "worker-does-not-exist",
        }),
        await sqlite.listJobs({
          workerId:
            "worker-does-not-exist",
        }),
      );

      assert.deepEqual(
        await postgres
          .listQueuedJobs(),
        await sqlite
          .listQueuedJobs(),
      );

      assert.deepEqual(
        await postgres
          .listActiveJobs(),
        await sqlite
          .listActiveJobs(),
      );

      const duplicateInput = {
        ...firstJob,
        id:
          "job-postgres-duplicate",
        payload: {
          echo:
            "should-not-replace-original",
        },
        now:
          firstJob.now + 500,
      };

      const postgresDuplicate =
        await postgres.insertJob(
          duplicateInput,
        );

      const sqliteDuplicate =
        await sqlite.insertJob(
          duplicateInput,
        );

      assert.deepEqual(
        postgresDuplicate,
        sqliteDuplicate,
      );

      assert.equal(
        postgresDuplicate.duplicate,
        true,
      );

      assert.equal(
        postgresDuplicate.job.id,
        firstJob.id,
      );

      assert.deepEqual(
        postgresDuplicate.job.payload,
        firstJob.payload,
      );

      const postgresJobs =
        await postgres.listJobs();

      const sqliteJobs =
        await sqlite.listJobs();

      assert.deepEqual(
        postgresJobs,
        sqliteJobs,
      );

      assert.equal(
        postgresJobs.length,
        2,
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

test(
  "PostgreSQL job lease lifecycle matches SQLite semantics",
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
        id: "worker-lease-parity",
        name: "lease-parity-worker",
        version: "1.0.0",
        baseUrl: null,
        labels: {},
        capabilities: [
          "diagnostic.echo",
        ],
        adapterManifests: [],
        adapterHealth: [],
        warmModels: [],
        modelInventory: [],
        gpus: [
          {
            uuid: "GPU-LEASE-PARITY",
            index: 0,
            name: "Lease Test GPU",
            memoryTotalMiB: 8192,
            memoryUsedMiB: 0,
            utilizationPercent: 0,
            temperatureC: 40,
            powerDrawWatts: 50,
          },
        ],
        now: initialNow,
      };

      await postgres.upsertWorker(worker);
      await sqlite.upsertWorker(worker);

      const job = {
        id: "job-lease-parity",
        projectId: "lease-test",
        type: "diagnostic.echo",
        priority: 0,
        minVramMiB: 1024,
        requiredCapabilities: [
          "diagnostic.echo",
        ],
        requestedModel: null,
        payload: {
          echo: "lease-test",
        },
        maxAttempts: 3,
        idempotencyKey: null,
        now: initialNow,
      };

      await postgres.insertJob(job);
      await sqlite.insertJob(job);

      const placement = {
        workerId: worker.id,
        gpuUuid:
          "GPU-LEASE-PARITY",
      };

      const leaseId =
        "lease-postgres-parity-1";

      const assignedAt =
        initialNow + 100;

      const assignedExpiresAt =
        initialNow + 10_100;

      const postgresAssigned =
        await postgres.assignJob(
          job.id,
          placement,
          leaseId,
          assignedExpiresAt,
          assignedAt,
        );

      const sqliteAssigned =
        await sqlite.assignJob(
          job.id,
          placement,
          leaseId,
          assignedExpiresAt,
          assignedAt,
        );

      assert.deepEqual(
        postgresAssigned,
        sqliteAssigned,
      );

      assert.equal(
        postgresAssigned.status,
        "leased",
      );

      assert.equal(
        postgresAssigned.attempt,
        1,
      );

      assert.equal(
        postgresAssigned.assignedWorkerId,
        worker.id,
      );

      assert.equal(
        postgresAssigned.assignedGpuUuid,
        placement.gpuUuid,
      );

      assert.equal(
        await postgres.assignJob(
          job.id,
          placement,
          "lease-second-attempt",
          assignedExpiresAt,
          assignedAt,
        ),
        null,
      );

      const startedAt =
        initialNow + 200;

      const runningExpiresAt =
        initialNow + 20_200;

      assert.equal(
        await postgres.startJob(
          job.id,
          "wrong-worker",
          leaseId,
          runningExpiresAt,
          startedAt,
        ),
        null,
      );

      const postgresStarted =
        await postgres.startJob(
          job.id,
          worker.id,
          leaseId,
          runningExpiresAt,
          startedAt,
        );

      const sqliteStarted =
        await sqlite.startJob(
          job.id,
          worker.id,
          leaseId,
          runningExpiresAt,
          startedAt,
        );

      assert.deepEqual(
        postgresStarted,
        sqliteStarted,
      );

      assert.equal(
        postgresStarted.status,
        "running",
      );

      const renewedAt =
        initialNow + 300;

      const renewedExpiresAt =
        initialNow + 30_300;

      assert.equal(
        await postgres.renewJob(
          job.id,
          worker.id,
          "wrong-lease",
          renewedExpiresAt,
          renewedAt,
        ),
        null,
      );

      const postgresRenewed =
        await postgres.renewJob(
          job.id,
          worker.id,
          leaseId,
          renewedExpiresAt,
          renewedAt,
        );

      const sqliteRenewed =
        await sqlite.renewJob(
          job.id,
          worker.id,
          leaseId,
          renewedExpiresAt,
          renewedAt,
        );

      assert.deepEqual(
        postgresRenewed,
        sqliteRenewed,
      );

      const finishedAt =
        initialNow + 400;

      const finishResult = {
        echo: "completed",
      };

      const postgresFinished =
        await postgres.finishJob(
          job.id,
          worker.id,
          leaseId,
          "succeeded",
          finishResult,
          null,
          finishedAt,
        );

      const sqliteFinished =
        await sqlite.finishJob(
          job.id,
          worker.id,
          leaseId,
          "succeeded",
          finishResult,
          null,
          finishedAt,
        );

      assert.deepEqual(
        postgresFinished,
        sqliteFinished,
      );

      assert.equal(
        postgresFinished.status,
        "succeeded",
      );

      assert.deepEqual(
        postgresFinished.result,
        finishResult,
      );

      assert.equal(
        postgresFinished.leaseExpiresAt,
        null,
      );

      assert.equal(
        await postgres.finishJob(
          job.id,
          worker.id,
          leaseId,
          "succeeded",
          finishResult,
          null,
          finishedAt + 1,
        ),
        null,
      );

      const cancellableJob = {
        ...job,
        id:
          "job-cancel-parity",
        now:
          initialNow + 500,
      };

      await postgres.insertJob(
        cancellableJob,
      );

      await sqlite.insertJob(
        cancellableJob,
      );

      const cancelledAt =
        initialNow + 600;

      const postgresCancelled =
        await postgres.cancelJob(
          cancellableJob.id,
          cancelledAt,
        );

      const sqliteCancelled =
        await sqlite.cancelJob(
          cancellableJob.id,
          cancelledAt,
        );

      assert.deepEqual(
        postgresCancelled,
        sqliteCancelled,
      );

      assert.equal(
        postgresCancelled.status,
        "cancelled",
      );

      assert.equal(
        await postgres.cancelJob(
          cancellableJob.id,
          cancelledAt + 1,
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

test(
  "PostgreSQL job recovery matches SQLite semantics",
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

    const normalizeRecoveries =
      (recoveries) =>
        [...recoveries].sort(
          (left, right) =>
            left.job.id.localeCompare(
              right.job.id,
            ),
        );

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

      const createWorker =
        (id, name) => ({
          id,
          name,
          version: "1.0.0",
          baseUrl: null,
          labels: {},
          capabilities: [
            "diagnostic.echo",
          ],
          adapterManifests: [],
          adapterHealth: [],
          warmModels: [],
          modelInventory: [],
          gpus: [
            {
              uuid: `GPU-${id}`,
              index: 0,
              name: "Recovery Test GPU",
              memoryTotalMiB: 8192,
              memoryUsedMiB: 0,
              utilizationPercent: 0,
              temperatureC: 40,
              powerDrawWatts: 50,
            },
          ],
          now: initialNow,
        });

      const liveWorker =
        createWorker(
          "worker-recovery-live",
          "recovery-live",
        );

      const offlineWorker =
        createWorker(
          "worker-recovery-offline",
          "recovery-offline",
        );

      for (
        const database of
        [postgres, sqlite]
      ) {
        await database.upsertWorker(
          liveWorker,
        );

        await database.upsertWorker(
          offlineWorker,
        );
      }

      const createJob =
        (
          id,
          maxAttempts,
          now,
        ) => ({
          id,
          projectId:
            "recovery-test",
          type:
            "diagnostic.echo",
          priority: 0,
          minVramMiB: 1024,
          requiredCapabilities: [
            "diagnostic.echo",
          ],
          requestedModel: null,
          payload: {
            job: id,
          },
          maxAttempts,
          idempotencyKey: null,
          now,
        });

      const expiredJob =
        createJob(
          "job-expired-requeue",
          3,
          initialNow,
        );

      const offlineJob =
        createJob(
          "job-offline-requeue",
          3,
          initialNow + 1,
        );

      const exhaustedJob =
        createJob(
          "job-expired-exhausted",
          1,
          initialNow + 2,
        );

      for (
        const database of
        [postgres, sqlite]
      ) {
        await database.insertJob(
          expiredJob,
        );

        await database.insertJob(
          offlineJob,
        );

        await database.insertJob(
          exhaustedJob,
        );
      }

      const recoveryNow =
        initialNow + 20_000;

      for (
        const database of
        [postgres, sqlite]
      ) {
        await database.assignJob(
          expiredJob.id,
          {
            workerId:
              liveWorker.id,
            gpuUuid:
              `GPU-${liveWorker.id}`,
          },
          "lease-expired",
          initialNow + 10_000,
          initialNow + 100,
        );

        await database.assignJob(
          offlineJob.id,
          {
            workerId:
              offlineWorker.id,
            gpuUuid:
              `GPU-${offlineWorker.id}`,
          },
          "lease-offline-worker",
          recoveryNow + 100_000,
          initialNow + 101,
        );

        await database.assignJob(
          exhaustedJob.id,
          {
            workerId:
              liveWorker.id,
            gpuUuid:
              `GPU-${liveWorker.id}`,
          },
          "lease-exhausted",
          initialNow + 10_000,
          initialNow + 102,
        );
      }

      const postgresRecovered =
        await postgres
          .recoverExpiredJobs(
            recoveryNow,
            [offlineWorker.id],
          );

      const sqliteRecovered =
        await sqlite
          .recoverExpiredJobs(
            recoveryNow,
            [offlineWorker.id],
          );

      assert.deepEqual(
        normalizeRecoveries(
          postgresRecovered,
        ),
        normalizeRecoveries(
          sqliteRecovered,
        ),
      );

      assert.equal(
        postgresRecovered.length,
        3,
      );

      const byId =
        Object.fromEntries(
          postgresRecovered.map(
            (recovery) => [
              recovery.job.id,
              recovery,
            ],
          ),
        );

      assert.equal(
        byId[
          expiredJob.id
        ].reason,
        "lease_expired",
      );

      assert.equal(
        byId[
          expiredJob.id
        ].job.status,
        "queued",
      );

      assert.equal(
        byId[
          offlineJob.id
        ].reason,
        "heartbeat_timeout",
      );

      assert.equal(
        byId[
          offlineJob.id
        ].job.status,
        "queued",
      );

      assert.equal(
        byId[
          exhaustedJob.id
        ].reason,
        "lease_expired",
      );

      assert.equal(
        byId[
          exhaustedJob.id
        ].job.status,
        "failed",
      );

      assert.deepEqual(
        byId[
          exhaustedJob.id
        ].job.error,
        {
          code:
            "lease_exhausted",
          message:
            "Job exhausted its execution attempts",
        },
      );

      for (
        const recovery of
        postgresRecovered
      ) {
        assert.equal(
          recovery.job
            .assignedWorkerId,
          null,
        );

        assert.equal(
          recovery.job
            .assignedGpuUuid,
          null,
        );

        assert.equal(
          recovery.job.leaseId,
          null,
        );

        assert.equal(
          recovery.job
            .leaseExpiresAt,
          null,
        );
      }

      assert.deepEqual(
        await postgres
          .listActiveJobs(),
        await sqlite
          .listActiveJobs(),
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

test(
  "PostgreSQL counts match SQLite semantics",
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

      assert.deepEqual(
        await postgres.counts(),
        await sqlite.counts(),
      );

      const initialNow =
        1_700_000_000_000;

      const worker = {
        id: "worker-counts",
        name: "counts-worker",
        version: "1.0.0",
        baseUrl: null,
        labels: {},
        capabilities: [
          "diagnostic.echo",
        ],
        adapterManifests: [],
        adapterHealth: [],
        warmModels: [],
        modelInventory: [],
        gpus: [
          {
            uuid:
              "GPU-COUNTS",
            index: 0,
            name:
              "Counts Test GPU",
            memoryTotalMiB:
              8192,
            memoryUsedMiB: 0,
            utilizationPercent: 0,
            temperatureC: 40,
            powerDrawWatts: 50,
          },
        ],
        now: initialNow,
      };

      for (
        const database of
        [postgres, sqlite]
      ) {
        await database.upsertWorker(
          worker,
        );
      }

      const queuedJob = {
        id: "job-counts-queued",
        projectId: "counts",
        type: "diagnostic.echo",
        priority: 0,
        minVramMiB: 1,
        requiredCapabilities: [
          "diagnostic.echo",
        ],
        requestedModel: null,
        payload: {},
        maxAttempts: 3,
        idempotencyKey: null,
        now: initialNow,
      };

      const cancelledJob = {
        ...queuedJob,
        id:
          "job-counts-cancelled",
        now:
          initialNow + 1,
      };

      for (
        const database of
        [postgres, sqlite]
      ) {
        await database.insertJob(
          queuedJob,
        );

        await database.insertJob(
          cancelledJob,
        );

        await database.cancelJob(
          cancelledJob.id,
          initialNow + 100,
        );
      }

      assert.deepEqual(
        await postgres.counts(),
        await sqlite.counts(),
      );

      const counts =
        await postgres.counts();

      assert.deepEqual(
        counts.workerCounts,
        {
          online: 1,
        },
      );

      assert.deepEqual(
        counts.jobCounts,
        {
          cancelled: 1,
          queued: 1,
        },
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
