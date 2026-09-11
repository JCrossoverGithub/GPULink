import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";

import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";

function deferred() {
  let resolve;

  const promise =
    new Promise(
      (resolvePromise) => {
        resolve = resolvePromise;
      },
    );

  return {
    promise,
    resolve,
  };
}

function timeout(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms),
  );
}

test(
  "SQLite notifies subscribers after committed events",
  async () => {
    const database =
      new SqlitePersistence(":memory:");

    let notifications = 0;

    const unsubscribe =
      await database
        .subscribeToEvents(
          () => {
            notifications += 1;
          },
        );

    try {
      await database.transaction(
        async (transaction) => {
          await transaction.appendEvent(
            "test.committed",
            null,
            {},
            1,
          );

          assert.equal(
            notifications,
            0,
          );
        },
      );

      assert.equal(
        notifications,
        1,
      );
    } finally {
      await unsubscribe();
      await database.close();
    }
  },
);

test(
  "SQLite does not notify subscribers for rolled back events",
  async () => {
    const database =
      new SqlitePersistence(":memory:");

    let notifications = 0;

    const unsubscribe =
      await database
        .subscribeToEvents(
          () => {
            notifications += 1;
          },
        );

    try {
      await assert.rejects(
        database.transaction(
          async (transaction) => {
            await transaction
              .appendEvent(
                "test.rollback",
                null,
                {},
                1,
              );

            throw new Error(
              "rollback",
            );
          },
        ),
        /rollback/u,
      );

      assert.equal(
        notifications,
        0,
      );
    } finally {
      await unsubscribe();
      await database.close();
    }
  },
);

const connectionString =
  process.env.GPULINK_TEST_POSTGRES_URL;

test(
  "PostgreSQL delivers committed event notifications across persistence instances",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const writer =
      new PostgresPersistence(
        connectionString,
      );

    const listener =
      new PostgresPersistence(
        connectionString,
      );

    const notified =
      deferred();

    let notifications = 0;
    let unsubscribe = null;

    try {
      await writer.initialize();
      await listener.initialize();

      unsubscribe =
        await listener
          .subscribeToEvents(
            () => {
              notifications += 1;
              notified.resolve();
            },
          );

      await writer.appendEvent(
        "test.cross-replica",
        null,
        {},
        Date.now(),
      );

      await Promise.race([
        notified.promise,
        timeout(2_000).then(
          () => {
            throw new Error(
              "timed out waiting for PostgreSQL notification",
            );
          },
        ),
      ]);

      assert.equal(
        notifications,
        1,
      );
    } finally {
      if (unsubscribe) {
        await unsubscribe();
      }

      await Promise.allSettled([
        writer.close(),
        listener.close(),
      ]);
    }
  },
);

test(
  "PostgreSQL suppresses event notifications on rollback",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const writer =
      new PostgresPersistence(
        connectionString,
      );

    const listener =
      new PostgresPersistence(
        connectionString,
      );

    let rolledBackSequence = null;
    let observedRolledBackNotification = false;
    let unsubscribe = null;

    try {
      await writer.initialize();
      await listener.initialize();

      unsubscribe =
        await listener
          .subscribeToEvents(
            (sequence) => {
              /*
               * Other PostgreSQL integration
               * tests may legitimately publish
               * on the shared notification
               * channel at the same time.
               *
               * Only a notification for this
               * transaction's event sequence
               * would demonstrate a rollback
               * notification leak.
               */
              if (
                sequence ===
                rolledBackSequence
              ) {
                observedRolledBackNotification =
                  true;
              }
            },
          );

      await assert.rejects(
        writer.transaction(
          async (transaction) => {
            const event =
              await transaction
                .appendEvent(
                  "test.rollback",
                  `rollback-${Date.now()}`,
                  {},
                  Date.now(),
                );

            rolledBackSequence =
              event.sequence;

            throw new Error(
              "rollback",
            );
          },
        ),
        /rollback/u,
      );

      assert.ok(
        Number.isSafeInteger(
          rolledBackSequence,
        ),
      );

      await timeout(150);

      assert.equal(
        observedRolledBackNotification,
        false,
      );

      const persisted =
        await writer
          .listEventsAfter(
            rolledBackSequence - 1,
          );

      assert.equal(
        persisted.some(
          (event) =>
            event.sequence ===
              rolledBackSequence,
        ),
        false,
      );
    } finally {
      if (unsubscribe) {
        await unsubscribe();
      }

      await Promise.allSettled([
        writer.close(),
        listener.close(),
      ]);
    }
  },
);
