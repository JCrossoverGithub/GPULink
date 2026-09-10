import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  assertPersistenceContract,
} from "../src/control-plane/persistence/contract.mjs";
import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";

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
