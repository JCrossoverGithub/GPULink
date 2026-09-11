import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSISTENCE_CONTROL_METHODS,
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "../src/control-plane/persistence/contract.mjs";
import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";

test("SQLite persistence implements the Promise-based contract", async () => {
  const database = new SqlitePersistence(":memory:");

  try {
    assert.equal(
      assertPersistenceContract(database),
      database,
    );

    for (const method of [
      ...PERSISTENCE_METHODS,
      ...PERSISTENCE_CONTROL_METHODS,
    ]) {
      assert.equal(
        typeof database[method],
        "function",
        `${method} is available`,
      );
    }

    const pendingCounts = database.counts();

    assert.equal(
      typeof pendingCounts.then,
      "function",
    );

    await pendingCounts;
  } finally {
    await database.close();
  }
});

test("SQLite persistence commits an asynchronous transaction", async () => {
  const database = new SqlitePersistence(":memory:");

  try {
    await database.transaction(async (transaction) => {
      await transaction.appendEvent(
        "test.committed",
        "subject-1",
        { committed: true },
        100,
      );

      await Promise.resolve();
    });

    const events = await database.listEventsAfter(0);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "test.committed");
    assert.equal(events[0].subjectId, "subject-1");
    assert.deepEqual(events[0].payload, {
      committed: true,
    });
  } finally {
    await database.close();
  }
});

test("SQLite persistence rolls back an asynchronous transaction", async () => {
  const database = new SqlitePersistence(":memory:");

  try {
    await assert.rejects(
      database.transaction(async (transaction) => {
        await transaction.appendEvent(
          "test.rolled-back",
          "subject-2",
          {},
          200,
        );

        await Promise.resolve();

        throw new Error("expected transaction failure");
      }),
      /expected transaction failure/,
    );

    const events = await database.listEventsAfter(0);

    assert.deepEqual(events, []);
  } finally {
    await database.close();
  }
});

test("SQLite persistence prevents operations from interleaving with a transaction", async () => {
  const database = new SqlitePersistence(":memory:");

  let enterTransaction;
  const enteredTransaction = new Promise((resolve) => {
    enterTransaction = resolve;
  });

  let releaseTransaction;
  const transactionGate = new Promise((resolve) => {
    releaseTransaction = resolve;
  });

  try {
    const transactionPromise =
      database.transaction(async (transaction) => {
        await transaction.appendEvent(
          "transaction.before",
          null,
          {},
          300,
        );

        enterTransaction();
        await transactionGate;

        await transaction.appendEvent(
          "transaction.after",
          null,
          {},
          301,
        );
      });

    await enteredTransaction;

    let outsideCompleted = false;

    const outsidePromise = database
      .appendEvent(
        "outside.transaction",
        null,
        {},
        302,
      )
      .then(() => {
        outsideCompleted = true;
      });

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(
      outsideCompleted,
      false,
      "outside operation must wait for the transaction",
    );

    releaseTransaction();

    await transactionPromise;
    await outsidePromise;

    const events = await database.listEventsAfter(0);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "transaction.before",
        "transaction.after",
        "outside.transaction",
      ],
    );
  } finally {
    await database.close();
  }
});

test(
  "SQLite transaction always acquires the scheduler lock",
  async () => {
    const database =
      new SqlitePersistence(":memory:");

    try {
      const acquired =
        await database.transaction(
          async (transaction) =>
            transaction
              .tryAcquireSchedulerLock(),
        );

      assert.equal(
        acquired,
        true,
      );
    } finally {
      await database.close();
    }
  },
);
