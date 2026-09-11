import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";

import {
  Scheduler,
} from "../src/control-plane/scheduler.mjs";

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );

  return {
    promise,
    resolve,
    reject,
  };
}

test(
  "scheduler skips a pass when another owner holds the scheduler lock",
  async () => {
    let transactionCalls = 0;

    const database = {
      async transaction(callback) {
        transactionCalls += 1;

        return callback({
          async tryAcquireSchedulerLock() {
            return false;
          },
        });
      },
    };

    const scheduler =
      new Scheduler(database, {
        heartbeatTimeoutMs: 60_000,
        leaseDurationMs: 10_000,
        vramSafetyMiB: 512,
        clock: () => 1_700_000_000_000,
      });

    const result =
      await scheduler.runOnce();

    assert.deepEqual(
      result,
      {
        acquired: false,
        staleWorkerIds: [],
        recoveredJobs: [],
        assigned: [],
      },
    );

    assert.equal(
      transactionCalls,
      1,
    );
  },
);

const connectionString =
  process.env.GPULINK_TEST_POSTGRES_URL;

test(
  "PostgreSQL scheduler advisory lock excludes concurrent transaction owners",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const first =
      new PostgresPersistence(
        connectionString,
      );

    const second =
      new PostgresPersistence(
        connectionString,
      );

    const entered =
      deferred();

    const release =
      deferred();

    try {
      await first.initialize();
      await second.initialize();

      const firstTransaction =
        first.transaction(
          async (transaction) => {
            const acquired =
              await transaction
                .tryAcquireSchedulerLock();

            assert.equal(
              acquired,
              true,
            );

            entered.resolve();

            await release.promise;
          },
        );

      await entered.promise;

      const concurrentAcquired =
        await second.transaction(
          async (transaction) =>
            transaction
              .tryAcquireSchedulerLock(),
        );

      assert.equal(
        concurrentAcquired,
        false,
      );

      release.resolve();

      await firstTransaction;

      const acquiredAfterCommit =
        await second.transaction(
          async (transaction) =>
            transaction
              .tryAcquireSchedulerLock(),
        );

      assert.equal(
        acquiredAfterCommit,
        true,
      );
    } finally {
      release.resolve();

      await Promise.allSettled([
        first.close(),
        second.close(),
      ]);
    }
  },
);
