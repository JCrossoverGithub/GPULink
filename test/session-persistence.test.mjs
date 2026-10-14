import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";
import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";

const { Pool } = pg;

const connectionString =
  process.env.GPULINK_TEST_POSTGRES_URL;

function sessionInput(
  overrides = {},
) {
  return {
    id: "session-test-1",
    schemaVersion: 1,
    projectId: "session-test",
    capability: "speech.streaming",
    priority: 10,
    requirements: {
      gpuCount: 1,
      minVramMiB: 16_384,
      capabilities: [
        "speech.streaming",
      ],
      model:
        "nvidia/parakeet-unified-en-0.6b",
      adapter:
        "speech.streaming.multitalker",
    },
    metadata: {
      protocol: "transgo-v1",
    },
    recovery: {
      maxInterruptions: 1,
    },
    idempotencyKey:
      "session-request-1",
    now:
      1_700_000_000_000,
    ...overrides,
  };
}

test(
  "SQLite stores generic requested sessions with project idempotency",
  async () => {
    const database =
      new SqlitePersistence(
        ":memory:",
      );

    try {
      const first =
        await database.insertSession(
          sessionInput(),
        );

      assert.equal(
        first.duplicate,
        false,
      );

      assert.deepEqual(
        first.session,
        {
          id: "session-test-1",
          schemaVersion: 1,
          projectId: "session-test",
          capability:
            "speech.streaming",
          priority: 10,
          status: "requested",
          requirements: {
            gpuCount: 1,
            minVramMiB: 16_384,
            capabilities: [
              "speech.streaming",
            ],
            model:
              "nvidia/parakeet-unified-en-0.6b",
            adapter:
              "speech.streaming.multitalker",
          },
          metadata: {
            protocol: "transgo-v1",
          },
          recovery: {
            maxInterruptions: 1,
          },
          interruptionCount: 0,
          assignedWorkerId: null,
          assignedGpuUuid: null,
          leaseId: null,
          leaseExpiresAt: null,
          idempotencyKey:
            "session-request-1",
          createdAt:
            1_700_000_000_000,
          updatedAt:
            1_700_000_000_000,
        },
      );

      const duplicate =
        await database.insertSession(
          sessionInput({
            id:
              "session-duplicate",
            priority: 999,
            now:
              1_700_000_000_500,
          }),
        );

      assert.equal(
        duplicate.duplicate,
        true,
      );

      assert.equal(
        duplicate.session.id,
        "session-test-1",
      );

      assert.equal(
        duplicate.session.priority,
        10,
      );

      assert.deepEqual(
        await database.getSession(
          "session-test-1",
        ),
        first.session,
      );

      assert.equal(
        await database.getSession(
          "session-missing",
        ),
        null,
      );

      const second =
        await database.insertSession(
          sessionInput({
            id: "session-test-2",
            priority: 50,
            idempotencyKey:
              "session-request-2",
            now:
              1_700_000_000_100,
          }),
        );

      assert.equal(
        second.duplicate,
        false,
      );

      assert.deepEqual(
        (
          await database
            .listRequestedSessions()
        ).map(
          (session) => session.id,
        ),
        [
          "session-test-2",
          "session-test-1",
        ],
      );

      assert.deepEqual(
        (
          await database.listSessions({
            status: "requested",
            limit: 1,
          })
        ).map(
          (session) => session.id,
        ),
        [
          "session-test-2",
        ],
      );

      assert.deepEqual(
        await database
          .listOccupyingSessions(),
        [],
      );
    } finally {
      await database.close();
    }
  },
);

test(
  "SQLite requested session state survives a database restart",
  async () => {
    const directory =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "gpulink-session-persistence-",
        ),
      );

    const filename =
      path.join(
        directory,
        "control-plane.sqlite",
      );

    let first = null;
    let second = null;

    try {
      first =
        new SqlitePersistence(
          filename,
        );

      await first.insertSession(
        sessionInput({
          id:
            "session-persistent",
          idempotencyKey:
            "session-persistent-key",
        }),
      );

      await first.close();
      first = null;

      second =
        new SqlitePersistence(
          filename,
        );

      const persisted =
        await second.getSession(
          "session-persistent",
        );

      assert.equal(
        persisted.status,
        "requested",
      );

      assert.equal(
        persisted.requirements.adapter,
        "speech.streaming.multitalker",
      );

      assert.deepEqual(
        persisted.metadata,
        {
          protocol: "transgo-v1",
        },
      );
    } finally {
      if (first) {
        await first.close();
      }

      if (second) {
        await second.close();
      }

      fs.rmSync(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "PostgreSQL session persistence matches SQLite semantics",
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
          sessions,
          events,
          jobs,
          workers
        RESTART IDENTITY CASCADE
      `);

      const first =
        sessionInput();

      const second =
        sessionInput({
          id: "session-test-2",
          priority: 50,
          idempotencyKey:
            "session-request-2",
          now:
            1_700_000_000_100,
        });

      assert.deepEqual(
        await postgres
          .insertSession(first),
        await sqlite
          .insertSession(first),
      );

      assert.deepEqual(
        await postgres
          .insertSession(second),
        await sqlite
          .insertSession(second),
      );

      assert.deepEqual(
        await postgres.getSession(
          first.id,
        ),
        await sqlite.getSession(
          first.id,
        ),
      );

      assert.deepEqual(
        await postgres.listSessions(),
        await sqlite.listSessions(),
      );

      assert.deepEqual(
        await postgres
          .listRequestedSessions(),
        await sqlite
          .listRequestedSessions(),
      );

      assert.deepEqual(
        await postgres
          .listOccupyingSessions(),
        await sqlite
          .listOccupyingSessions(),
      );

      const placement = {
        workerId: null,
        gpuUuid: "GPU-SESSION-PARITY",
      };

      assert.deepEqual(
        await postgres.assignSession(
          first.id,
          placement,
          "lease-session-parity",
          first.now + 10_000,
          first.now + 100,
        ),
        await sqlite.assignSession(
          first.id,
          placement,
          "lease-session-parity",
          first.now + 10_000,
          first.now + 100,
        ),
      );

      assert.deepEqual(
        await postgres
          .listOccupyingSessions(),
        await sqlite
          .listOccupyingSessions(),
      );

      const duplicate = {
        ...first,
        id:
          "session-test-duplicate",
        priority: 999,
        now:
          first.now + 500,
      };

      assert.deepEqual(
        await postgres
          .insertSession(duplicate),
        await sqlite
          .insertSession(duplicate),
      );
    } finally {
      await inspector.end();
      await postgres.close();
      await sqlite.close();
    }
  },
);
