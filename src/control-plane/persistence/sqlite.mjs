import { ControlPlaneDatabase } from "../database.mjs";
import {
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "./contract.mjs";

function createTransactionView(
  database,
  markEventWritten,
) {
  const transaction = {};

  for (const method of PERSISTENCE_METHODS) {
    transaction[method] =
      async (...args) => {
        const result =
          await Promise.resolve()
            .then(
              () =>
                database[method](
                  ...args,
                ),
            );

        if (method === "appendEvent") {
          markEventWritten();
        }

        return result;
      };
  }

  transaction.tryAcquireSchedulerLock =
    async () => true;

  return Object.freeze(transaction);
}

export class SqlitePersistence {
  #database;
  #tail = Promise.resolve();
  #closed = false;
  #closePromise = null;
  #eventSubscribers = new Set();

  constructor(filename = ":memory:") {
    this.#database =
      new ControlPlaneDatabase(filename);

    assertPersistenceContract(this);
  }

  transaction(callback) {
    if (typeof callback !== "function") {
      return Promise.reject(
        new TypeError(
          "transaction callback must be a function",
        ),
      );
    }

    return this.#enqueue(async () => {
      this.#assertOpen();

      this.#database.database.exec(
        "BEGIN IMMEDIATE",
      );

      let eventWritten = false;

      try {
        const transaction =
          createTransactionView(
            this.#database,
            () => {
              eventWritten = true;
            },
          );

        const result =
          await callback(transaction);

        this.#database.database.exec(
          "COMMIT",
        );

        if (eventWritten) {
          this.#notifyEventSubscribers();
        }

        return result;
      } catch (error) {
        try {
          this.#database.database.exec(
            "ROLLBACK",
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [
              error,
              rollbackError,
            ],
            "SQLite transaction rollback failed",
          );
        }

        throw error;
      }
    });
  }

  async subscribeToEvents(listener) {
    this.#assertOpen();

    if (typeof listener !== "function") {
      throw new TypeError(
        "event listener must be a function",
      );
    }

    this.#eventSubscribers.add(
      listener,
    );

    let subscribed = true;

    return async () => {
      if (!subscribed) return;

      subscribed = false;

      this.#eventSubscribers.delete(
        listener,
      );
    };
  }

  close() {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closePromise =
      this.#enqueue(() => {
        if (this.#closed) return;

        this.#eventSubscribers.clear();

        this.#database.close();
        this.#closed = true;
      });

    return this.#closePromise;
  }

  upsertWorker(...args) {
    return this.#call(
      "upsertWorker",
      args,
    );
  }

  updateWorkerHeartbeat(...args) {
    return this.#call(
      "updateWorkerHeartbeat",
      args,
    );
  }

  setWorkerDrain(...args) {
    return this.#call(
      "setWorkerDrain",
      args,
    );
  }

  listWorkers(...args) {
    return this.#call(
      "listWorkers",
      args,
    );
  }

  getWorker(...args) {
    return this.#call(
      "getWorker",
      args,
    );
  }

  markStaleWorkersOffline(...args) {
    return this.#call(
      "markStaleWorkersOffline",
      args,
    );
  }

  insertJob(...args) {
    return this.#call(
      "insertJob",
      args,
    );
  }

  getJob(...args) {
    return this.#call(
      "getJob",
      args,
    );
  }

  listJobs(...args) {
    return this.#call(
      "listJobs",
      args,
    );
  }

  listQueuedJobs(...args) {
    return this.#call(
      "listQueuedJobs",
      args,
    );
  }

  listActiveJobs(...args) {
    return this.#call(
      "listActiveJobs",
      args,
    );
  }

  assignJob(...args) {
    return this.#call(
      "assignJob",
      args,
    );
  }

  startJob(...args) {
    return this.#call(
      "startJob",
      args,
    );
  }

  renewJob(...args) {
    return this.#call(
      "renewJob",
      args,
    );
  }

  finishJob(...args) {
    return this.#call(
      "finishJob",
      args,
    );
  }

  cancelJob(...args) {
    return this.#call(
      "cancelJob",
      args,
    );
  }

  recoverExpiredJobs(...args) {
    return this.#call(
      "recoverExpiredJobs",
      args,
    );
  }

  appendEvent(...args) {
    return this.#enqueue(() => {
      this.#assertOpen();

      const event =
        this.#database.appendEvent(
          ...args,
        );

      this.#notifyEventSubscribers();

      return event;
    });
  }

  listEventsAfter(...args) {
    return this.#call(
      "listEventsAfter",
      args,
    );
  }

  counts(...args) {
    return this.#call(
      "counts",
      args,
    );
  }

  #call(method, args) {
    return this.#enqueue(() => {
      this.#assertOpen();

      return this.#database[
        method
      ](...args);
    });
  }

  #notifyEventSubscribers() {
    for (
      const listener of
      this.#eventSubscribers
    ) {
      try {
        Promise.resolve(
          listener(),
        ).catch(
          (error) => {
            console.error(
              "SQLite event listener failed",
              error,
            );
          },
        );
      } catch (error) {
        console.error(
          "SQLite event listener failed",
          error,
        );
      }
    }
  }

  #enqueue(operation) {
    const result =
      this.#tail.then(
        operation,
        operation,
      );

    this.#tail =
      result.then(
        () => undefined,
        () => undefined,
      );

    return result;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error(
        "persistence is closed",
      );
    }
  }
}
