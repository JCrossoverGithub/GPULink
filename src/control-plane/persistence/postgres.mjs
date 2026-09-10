import {
  createHash,
} from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import {
  fileURLToPath,
} from "node:url";

import pg from "pg";

import {
  PERSISTENCE_METHODS,
  assertPersistenceContract,
} from "./contract.mjs";

const { Pool } = pg;

const DEFAULT_MIGRATIONS_DIRECTORY =
  fileURLToPath(
    new URL(
      "./migrations/postgres/",
      import.meta.url,
    ),
  );

const MIGRATION_LOCK_NAME =
  "gpulink-schema-migrations";

export class PostgresPersistence {
  #pool;
  #migrationsDirectory;
  #initializePromise = null;
  #initialized = false;
  #closePromise = null;
  #closed = false;

  constructor(
    connectionString,
    {
      maxConnections = 10,
      idleTimeoutMs = 30_000,
      connectionTimeoutMs = 5_000,
      migrationsDirectory =
        DEFAULT_MIGRATIONS_DIRECTORY,
    } = {},
  ) {
    if (
      typeof connectionString !== "string" ||
      connectionString.trim() === ""
    ) {
      throw new TypeError(
        "PostgreSQL connection string must be a non-empty string",
      );
    }

    if (
      !Number.isSafeInteger(maxConnections) ||
      maxConnections <= 0
    ) {
      throw new TypeError(
        "maxConnections must be a positive integer",
      );
    }

    this.#migrationsDirectory =
      migrationsDirectory;

    this.#pool = new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: idleTimeoutMs,
      connectionTimeoutMillis:
        connectionTimeoutMs,
    });

    this.#pool.on(
      "error",
      (error) => {
        console.error(
          "PostgreSQL pool error",
          error,
        );
      },
    );

    assertPersistenceContract(this);
  }

  initialize() {
    if (this.#closed) {
      return Promise.reject(
        new Error(
          "PostgreSQL persistence is closed",
        ),
      );
    }

    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#initializePromise =
      this.#initialize()
        .catch((error) => {
          this.#initializePromise = null;
          throw error;
        });

    return this.#initializePromise;
  }

  async #initialize() {
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtext($1)::bigint
          )
        `,
        [MIGRATION_LOCK_NAME],
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS
          gpulink_schema_migrations (
            filename TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ
              NOT NULL DEFAULT NOW()
          )
      `);

      const entries =
        await readdir(
          this.#migrationsDirectory,
          {
            withFileTypes: true,
          },
        );

      const filenames =
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith(".sql"),
          )
          .map((entry) => entry.name)
          .sort();

      for (const filename of filenames) {
        const migrationPath =
          path.join(
            this.#migrationsDirectory,
            filename,
          );

        const sql =
          await readFile(
            migrationPath,
            "utf8",
          );

        const checksum =
          createHash("sha256")
            .update(sql)
            .digest("hex");

        const existing =
          await client.query(
            `
              SELECT checksum
              FROM gpulink_schema_migrations
              WHERE filename = $1
            `,
            [filename],
          );

        if (existing.rowCount > 0) {
          if (
            existing.rows[0].checksum !==
            checksum
          ) {
            throw new Error(
              `PostgreSQL migration ${filename} has changed after being applied`,
            );
          }

          continue;
        }

        await client.query(sql);

        await client.query(
          `
            INSERT INTO
              gpulink_schema_migrations (
                filename,
                checksum
              )
            VALUES ($1, $2)
          `,
          [
            filename,
            checksum,
          ],
        );
      }

      await client.query("COMMIT");

      this.#initialized = true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [
            error,
            rollbackError,
          ],
          "PostgreSQL migration rollback failed",
        );
      }

      throw error;
    } finally {
      client.release();
    }

    return this;
  }

  async transaction(callback) {
    this.#assertReady();

    if (typeof callback !== "function") {
      throw new TypeError(
        "transaction callback must be a function",
      );
    }

    const client =
      await this.#pool.connect();

    try {
      await client.query("BEGIN");

      const transaction =
        this.#createTransactionView(
          client,
        );

      const result =
        await callback(transaction);

      await client.query("COMMIT");

      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [
            error,
            rollbackError,
          ],
          "PostgreSQL transaction rollback failed",
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closed = true;

    this.#closePromise =
      (async () => {
        if (this.#initializePromise) {
          try {
            await this.#initializePromise;
          } catch {
            // Initialization failure does not
            // prevent the pool from closing.
          }
        }

        await this.#pool.end();
        this.#initialized = false;
      })();

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
    return this.#call(
      "appendEvent",
      args,
    );
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

  #createTransactionView(client) {
    const transaction = {};

    for (
      const method of
      PERSISTENCE_METHODS
    ) {
      transaction[method] =
        (...args) =>
          this.#call(
            method,
            args,
            client,
          );
    }

    return Object.freeze(
      transaction,
    );
  }

  #call(method, args, client = null) {
    this.#assertReady();

    return Promise.reject(
      new Error(
        `PostgreSQL persistence method ${method} is not implemented`,
        {
          cause: {
            method,
            argumentCount: args.length,
            transactional:
              client !== null,
          },
        },
      ),
    );
  }

  #assertReady() {
    if (this.#closed) {
      throw new Error(
        "PostgreSQL persistence is closed",
      );
    }

    if (!this.#initialized) {
      throw new Error(
        "PostgreSQL persistence is not initialized",
      );
    }
  }
}
