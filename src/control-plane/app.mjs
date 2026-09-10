import { SqlitePersistence } from "./persistence/sqlite.mjs";
import { Scheduler } from "./scheduler.mjs";
import { ControlPlaneService } from "./service.mjs";
import { createHttpServer } from "./http-server.mjs";

export function createControlPlane(
  config,
  options = {},
) {
  const database =
    options.database ??
    new SqlitePersistence(config.dataPath);

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

  const service =
    new ControlPlaneService(
      database,
      scheduler,
      config,
      {
        clock: options.clock,
      },
    );

  const server =
    createHttpServer({
      service,
      database,
      scheduler,
    });

  let schedulerTimer = null;
  let schedulerCycle = null;
  let stopping = false;

  function scheduleNextCycle() {
    if (stopping) return;

    schedulerTimer = setTimeout(() => {
      schedulerTimer = null;

      const cycle =
        scheduler.runOnce()
          .catch((error) => {
            console.error(
              "scheduler cycle failed",
              error,
            );
          });

      schedulerCycle = cycle;

      cycle.finally(() => {
        if (schedulerCycle === cycle) {
          schedulerCycle = null;
        }

        scheduleNextCycle();
      });
    }, config.schedulerIntervalMs);

    schedulerTimer.unref();
  }

  return {
    database,
    scheduler,
    service,
    server,

    async start() {
      stopping = false;

      await scheduler.runOnce();

      await new Promise(
        (resolve, reject) => {
          server.once("error", reject);

          server.listen(
            config.port,
            config.host,
            () => {
              server.off("error", reject);
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
        clearTimeout(schedulerTimer);
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

      if (schedulerCycle) {
        await schedulerCycle;
      }

      await database.close();
    },
  };
}
