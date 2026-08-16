import { ControlPlaneDatabase } from "./database.mjs";
import { Scheduler } from "./scheduler.mjs";
import { ControlPlaneService } from "./service.mjs";
import { createHttpServer } from "./http-server.mjs";

export function createControlPlane(config, options = {}) {
  const database = options.database ?? new ControlPlaneDatabase(config.dataPath);
  const scheduler = options.scheduler ?? new Scheduler(database, {
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    leaseDurationMs: config.leaseDurationMs,
    vramSafetyMiB: config.vramSafetyMiB,
    clock: options.clock,
  });
  const service = new ControlPlaneService(database, scheduler, config, {
    clock: options.clock,
  });
  const server = createHttpServer({ service, database, scheduler });
  let schedulerTimer = null;

  return {
    database,
    scheduler,
    service,
    server,
    async start() {
      scheduler.runOnce();
      schedulerTimer = setInterval(() => {
        try {
          scheduler.runOnce();
        } catch (error) {
          console.error("scheduler cycle failed", error);
        }
      }, config.schedulerIntervalMs);
      schedulerTimer.unref();

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async stop() {
      if (schedulerTimer) clearInterval(schedulerTimer);
      if (server.listening) {
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
      database.close();
    },
  };
}
