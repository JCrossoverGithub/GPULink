import { PostgresPersistence } from "./persistence/postgres.mjs";
import { SqlitePersistence } from "./persistence/sqlite.mjs";
import { SchedulerRunner } from "./scheduler-runner.mjs";
import { Scheduler } from "./scheduler.mjs";
import { ControlPlaneService } from "./service.mjs";
import { createHttpServer } from "./http-server.mjs";

export function createControlPlane(
  config,
  options = {},
) {
  const database =
    options.database ??
    createPersistence(config);

  const scheduler =
    options.scheduler ??
    new Scheduler(database, {
      heartbeatTimeoutMs:
        config.heartbeatTimeoutMs,
      leaseDurationMs:
        config.leaseDurationMs,
      vramSafetyMiB:
        config.vramSafetyMiB,
      clock: options.clock,
    });

  const schedulerRunner =
    options.schedulerRunner ??
    new SchedulerRunner(scheduler);

  /*
   * Service and HTTP scheduling triggers both use
   * the same runner. SchedulerRunner exposes the
   * existing runOnce() interface, so callers keep
   * their current semantics while concurrent
   * requests are coalesced.
   */
  const service =
    new ControlPlaneService(
      database,
      schedulerRunner,
      config,
      {
        clock: options.clock,
      },
    );

  const server =
    createHttpServer({
      service,
      database,
      scheduler: schedulerRunner,
    });

  let schedulerTimer = null;
  let stopping = false;

  function scheduleNextCycle() {
    if (stopping) return;

    schedulerTimer = setTimeout(() => {
      schedulerTimer = null;

      schedulerRunner
        .trigger()
        .catch((error) => {
          console.error(
            "scheduler cycle failed",
            error,
          );
        })
        .finally(() => {
          scheduleNextCycle();
        });
    }, config.schedulerIntervalMs);

    schedulerTimer.unref();
  }

  return {
    database,
    scheduler,
    schedulerRunner,
    service,
    server,

    async start() {
      stopping = false;

      if (
        typeof database.initialize ===
        "function"
      ) {
        await database.initialize();
      }

      await schedulerRunner.trigger();

      await new Promise(
        (resolve, reject) => {
          server.once("error", reject);

          server.listen(
            config.port,
            config.host,
            () => {
              server.off(
                "error",
                reject,
              );
              resolve();
            },
          );
        },
      );

      scheduleNextCycle();

      return server.address();
    },

    async stop() {
      stopping = true;

      if (schedulerTimer) {
        clearTimeout(
          schedulerTimer,
        );
        schedulerTimer = null;
      }

      if (server.listening) {
        await new Promise(
          (resolve, reject) =>
            server.close((error) =>
              error
                ? reject(error)
                : resolve()),
        );
      }

      await schedulerRunner.stop();

      await database.close();
    },
  };
}

function createPersistence(config) {
  switch (config.database) {
    case undefined:
    case "sqlite":
      return new SqlitePersistence(
        config.dataPath,
      );

    case "postgres":
      return new PostgresPersistence(
        config.databaseUrl,
      );

    default:
      throw new Error(
        `Unsupported control-plane database ${config.database}`,
      );
  }
}
