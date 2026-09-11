import assert from "node:assert/strict";
import test from "node:test";

import {
  SchedulerRunner,
} from "../src/control-plane/scheduler-runner.mjs";

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
  "scheduler runner executes one trigger while idle",
  async () => {
    let runs = 0;

    const runner =
      new SchedulerRunner({
        async runOnce() {
          runs += 1;
        },
      });

    await runner.trigger();

    assert.equal(runs, 1);
    assert.equal(runner.running, false);
  },
);

test(
  "scheduler runner coalesces concurrent triggers into one follow-up pass",
  async () => {
    const first = deferred();
    const second = deferred();

    let runs = 0;

    const scheduler = {
      async runOnce() {
        runs += 1;

        if (runs === 1) {
          await first.promise;
          return;
        }

        if (runs === 2) {
          await second.promise;
        }
      },
    };

    const runner =
      new SchedulerRunner(scheduler);

    const initial =
      runner.trigger();

    /*
     * Allow the first pass to enter runOnce().
     */
    await Promise.resolve();

    assert.equal(runs, 1);

    const triggers = Array.from(
      { length: 10 },
      () => runner.trigger(),
    );

    assert.equal(runs, 1);

    first.resolve();

    /*
     * Allow the coalesced second pass to begin.
     */
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(runs, 2);

    second.resolve();

    await Promise.all([
      initial,
      ...triggers,
    ]);

    assert.equal(runs, 2);
    assert.equal(runner.running, false);
  },
);

test(
  "scheduler runner never overlaps passes",
  async () => {
    const gates = [
      deferred(),
      deferred(),
    ];

    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const runner =
      new SchedulerRunner({
        async runOnce() {
          const index = runs;

          runs += 1;
          active += 1;

          maxActive = Math.max(
            maxActive,
            active,
          );

          await gates[index].promise;

          active -= 1;
        },
      });

    const first =
      runner.trigger();

    await Promise.resolve();

    const second =
      runner.trigger();

    gates[0].resolve();

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(runs, 2);
    assert.equal(maxActive, 1);

    gates[1].resolve();

    await Promise.all([
      first,
      second,
    ]);

    assert.equal(maxActive, 1);
  },
);

test(
  "scheduler runner stop waits for current pass and cancels pending rerun",
  async () => {
    const gate = deferred();

    let runs = 0;

    const runner =
      new SchedulerRunner({
        async runOnce() {
          runs += 1;
          await gate.promise;
        },
      });

    const cycle =
      runner.trigger();

    await Promise.resolve();

    assert.equal(runs, 1);

    /*
     * This would ordinarily request exactly one
     * additional pass.
     */
    const pending =
      runner.trigger();

    let stopped = false;

    const stopping =
      runner.stop()
        .then(() => {
          stopped = true;
        });

    await Promise.resolve();

    assert.equal(stopped, false);

    gate.resolve();

    await Promise.all([
      cycle,
      pending,
      stopping,
    ]);

    assert.equal(stopped, true);
    assert.equal(runs, 1);
    assert.equal(runner.running, false);
    assert.equal(runner.stopping, true);
  },
);

test(
  "scheduler runner rejects triggers after shutdown begins",
  async () => {
    const runner =
      new SchedulerRunner({
        async runOnce() {},
      });

    await runner.stop();

    await assert.rejects(
      runner.trigger(),
      /SchedulerRunner is stopping/,
    );
  },
);

test(
  "scheduler runner returns the final scheduler result",
  async () => {
    const expected = {
      staleWorkerIds: [],
      recoveredJobs: [],
      assigned: ["job-1"],
    };

    const runner =
      new SchedulerRunner({
        async runOnce() {
          return expected;
        },
      });

    const result =
      await runner.trigger();

    assert.deepEqual(
      result,
      expected,
    );
  },
);

test(
  "scheduler runner runOnce uses the coalescing trigger path",
  async () => {
    let runs = 0;

    const expected = {
      staleWorkerIds: [],
      recoveredJobs: [],
      assigned: [],
    };

    const runner =
      new SchedulerRunner({
        async runOnce() {
          runs += 1;
          return expected;
        },
      });

    const result =
      await runner.runOnce();

    assert.equal(runs, 1);
    assert.deepEqual(
      result,
      expected,
    );
  },
);
