import { SqlitePersistence } from "../src/control-plane/persistence/sqlite.mjs";
import { Scheduler } from "../src/control-plane/scheduler.mjs";
import { ControlPlaneService } from "../src/control-plane/service.mjs";

export function createTestContext({
  initialNow = 1_700_000_000_000,
  heartbeatTimeoutMs = 60_000,
  leaseDurationMs = 10_000,
  vramSafetyMiB = 512,
} = {}) {
  let now = initialNow;
  const clock = () => now;

  const config = {
    tokens: {
      client:
        "test-client-token-that-is-at-least-32-characters",
      worker:
        "test-worker-token-that-is-at-least-32-characters",
      admin:
        "test-admin-token-that-is-at-least-32-characters",
    },
    heartbeatTimeoutMs,
    leaseDurationMs,
    vramSafetyMiB,
  };

  const database =
    new SqlitePersistence(":memory:");

  const scheduler =
    new Scheduler(database, {
      heartbeatTimeoutMs,
      leaseDurationMs,
      vramSafetyMiB,
      clock,
    });

  const service =
    new ControlPlaneService(
      database,
      scheduler,
      config,
      { clock },
    );

  return {
    config,
    database,
    scheduler,
    service,
    clock,

    advance(milliseconds) {
      now += milliseconds;
      return now;
    },

    async close() {
      await database.close();
    },
  };
}

export function gpu({
  uuid,
  name = "Test GPU",
  memoryTotalMiB,
  memoryUsedMiB = 0,
  utilizationPercent = 0,
  index = 0,
} = {}) {
  return {
    uuid,
    index,
    name,
    memoryTotalMiB,
    memoryUsedMiB,
    utilizationPercent,
    temperatureC: 40,
    powerDrawWatts: 50,
  };
}

export async function registerWorker(
  context,
  {
    name,
    gpus,
    capabilities = ["diagnostic.echo"],
    warmModels = [],
    modelInventory = [],
  } = {},
) {
  return context.service.registerWorker({
    name,
    version: "test",
    labels: {},
    capabilities,
    warmModels,
    modelInventory,
    gpus,
  });
}

export async function submitJob(
  context,
  overrides = {},
) {
  const result =
    await context.service.submitJob({
      projectId: "test-project",
      type: "diagnostic.echo",
      priority: 0,
      constraints: {
        gpuCount: 1,
        minVramMiB: 1,
        capabilities: [
          "diagnostic.echo",
        ],
        ...overrides.constraints,
      },
      payload: {},
      maxAttempts: 3,
      ...overrides,
    });

  return result.job;
}
