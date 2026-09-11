import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";

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

const tokens = {
  client:
    "lifecycle-client-token-at-least-32-characters",
  worker:
    "lifecycle-worker-token-at-least-32-characters",
  admin:
    "lifecycle-admin-token-at-least-32-characters",
};

test(
  "control plane shutdown waits for scheduler work before closing persistence",
  async () => {
    const database =
      new SqlitePersistence(":memory:");

    const originalClose =
      database.close.bind(database);

    let databaseClosed = false;

    database.close =
      async () => {
        databaseClosed = true;
        await originalClose();
      };

    const secondStarted =
      deferred();

    const releaseSecond =
      deferred();

    let runs = 0;

    const scheduler = {
      async runOnce() {
        runs += 1;

        /*
         * The startup pass completes immediately.
         */
        if (runs === 1) {
          return {
            staleWorkerIds: [],
            recoveredJobs: [],
            assigned: [],
          };
        }

        /*
         * Hold the next pass open so shutdown
         * ordering can be observed.
         */
        if (runs === 2) {
          secondStarted.resolve();

          await releaseSecond.promise;

          return {
            staleWorkerIds: [],
            recoveredJobs: [],
            assigned: [],
          };
        }

        throw new Error(
          `unexpected scheduler pass ${runs}`,
        );
      },
    };

    const app =
      createControlPlane(
        {
          host: "127.0.0.1",
          port: 0,
          dataPath: ":memory:",
          tokens,
          heartbeatTimeoutMs:
            60_000,
          leaseDurationMs:
            10_000,
          schedulerIntervalMs:
            60_000,
          vramSafetyMiB:
            512,
        },
        {
          database,
          scheduler,
        },
      );

    await app.start();

    assert.equal(runs, 1);

    /*
     * ControlPlaneService must receive the same
     * coalescing runner owned by the application.
     */
    assert.equal(
      app.service.scheduler,
      app.schedulerRunner,
    );

    /*
     * Begin a scheduler pass and hold it open.
     */
    const running =
      app.schedulerRunner.trigger();

    await secondStarted.promise;

    assert.equal(runs, 2);

    /*
     * Request another pass while the current one
     * is running. Ordinarily this would become one
     * coalesced follow-up pass.
     */
    const pending =
      app.schedulerRunner.trigger();

    /*
     * Shutdown must wait for pass 2 and must not
     * close persistence yet.
     */
    const stopping =
      app.stop();

    await new Promise(
      (resolve) =>
        setImmediate(resolve),
    );

    assert.equal(
      databaseClosed,
      false,
    );

    /*
     * Allow the in-flight scheduler transaction
     * to finish.
     */
    releaseSecond.resolve();

    await Promise.all([
      running,
      pending,
      stopping,
    ]);

    assert.equal(
      databaseClosed,
      true,
    );

    /*
     * The pending trigger was discarded during
     * shutdown rather than becoming pass 3.
     */
    assert.equal(runs, 2);

    assert.equal(
      app.schedulerRunner.stopping,
      true,
    );
  },
);
