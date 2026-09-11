export class SchedulerRunner {
  #scheduler;
  #pending = false;
  #drainPromise = null;
  #stopping = false;

  constructor(scheduler) {
    if (
      scheduler === null ||
      typeof scheduler !== "object" ||
      typeof scheduler.runOnce !== "function"
    ) {
      throw new TypeError(
        "scheduler.runOnce must be a function",
      );
    }

    this.#scheduler = scheduler;
  }

  get running() {
    return this.#drainPromise !== null;
  }

  get stopping() {
    return this.#stopping;
  }

  trigger() {
    if (this.#stopping) {
      return Promise.reject(
        new Error(
          "SchedulerRunner is stopping",
        ),
      );
    }

    this.#pending = true;

    if (!this.#drainPromise) {
      this.#drainPromise =
        this.#drain();
    }

    return this.#drainPromise;
  }

  async stop() {
    this.#stopping = true;

    /*
     * A trigger that arrived while a pass was
     * running normally requests one coalesced
     * follow-up pass. During shutdown we do not
     * start new scheduler work; only the current
     * pass is allowed to finish.
     */
    this.#pending = false;

    if (this.#drainPromise) {
      await this.#drainPromise;
    }
  }

  async #drain() {
    try {
      while (
        this.#pending &&
        !this.#stopping
      ) {
        this.#pending = false;

        await this.#scheduler.runOnce();
      }
    } finally {
      this.#drainPromise = null;
    }
  }
}
