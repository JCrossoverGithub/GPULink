import { ControlPlaneDatabase } from "../database.mjs";
import {
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "./contract.mjs";

function createTransactionView(database) {
  const transaction = {};

  for (const method of PERSISTENCE_METHODS) {
    transaction[method] = (...args) =>
      Promise.resolve().then(() => database[method](...args));
  }

  return Object.freeze(transaction);
}

export class SqlitePersistence {
  #database;
  #tail = Promise.resolve();
  #closed = false;
  #closePromise = null;

  constructor(filename = ":memory:") {
    this.#database = new ControlPlaneDatabase(filename);
    assertPersistenceContract(this);
  }

  transaction(callback) {
    if (typeof callback !== "function") {
      return Promise.reject(
        new TypeError("transaction callback must be a function"),
      );
    }

    return this.#enqueue(async () => {
      this.#assertOpen();

      // The legacy SQLite implementation intentionally remains
      // synchronous. This adapter owns the database instance and
      // serializes the entire asynchronous callback so no other
      // persistence operation can interleave while BEGIN IMMEDIATE
      // is active.
      this.#database.database.exec("BEGIN IMMEDIATE");

      try {
        const transaction =
          createTransactionView(this.#database);

        const result = await callback(transaction);

        this.#database.database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#database.database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction rollback failed",
          );
        }

        throw error;
      }
    });
  }

  close() {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closePromise = this.#enqueue(() => {
      if (this.#closed) return;

      this.#database.close();
      this.#closed = true;
    });

    return this.#closePromise;
  }

  upsertWorker(...args) {
    return this.#call("upsertWorker", args);
  }

  updateWorkerHeartbeat(...args) {
    return this.#call("updateWorkerHeartbeat", args);
  }

  setWorkerDrain(...args) {
    return this.#call("setWorkerDrain", args);
  }

  listWorkers(...args) {
    return this.#call("listWorkers", args);
  }

  getWorker(...args) {
    return this.#call("getWorker", args);
  }

  markStaleWorkersOffline(...args) {
    return this.#call("markStaleWorkersOffline", args);
  }

  insertJob(...args) {
    return this.#call("insertJob", args);
  }

  getJob(...args) {
    return this.#call("getJob", args);
  }

  listJobs(...args) {
    return this.#call("listJobs", args);
  }

  listQueuedJobs(...args) {
    return this.#call("listQueuedJobs", args);
  }

  listActiveJobs(...args) {
    return this.#call("listActiveJobs", args);
  }

  assignJob(...args) {
    return this.#call("assignJob", args);
  }

  startJob(...args) {
    return this.#call("startJob", args);
  }

  renewJob(...args) {
    return this.#call("renewJob", args);
  }

  finishJob(...args) {
    return this.#call("finishJob", args);
  }

  cancelJob(...args) {
    return this.#call("cancelJob", args);
  }

  recoverExpiredJobs(...args) {
    return this.#call("recoverExpiredJobs", args);
  }

  appendEvent(...args) {
    return this.#call("appendEvent", args);
  }

  listEventsAfter(...args) {
    return this.#call("listEventsAfter", args);
  }

  counts(...args) {
    return this.#call("counts", args);
  }

  #call(method, args) {
    return this.#enqueue(() => {
      this.#assertOpen();
      return this.#database[method](...args);
    });
  }

  #enqueue(operation) {
    const result = this.#tail.then(operation, operation);

    // Keep the queue usable after a rejected operation while
    // returning the original rejection to that operation's caller.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("persistence is closed");
    }
  }
}
