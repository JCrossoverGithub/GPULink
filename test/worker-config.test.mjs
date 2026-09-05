import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkerConfig } from "../src/worker/config.mjs";

const baseEnvironment = {
  GPULINK_WORKER_TOKEN: "worker-config-test-token-at-least-32-characters",
  GPULINK_WORKER_NAME: "config-test-worker",
};

test("loads bounded benchmark runtime defaults", () => {
  const config = loadWorkerConfig(baseEnvironment);
  assert.equal(config.capabilityProbeIntervalMs, 300_000);
  assert.equal(config.modelInventoryIntervalMs, 300_000);
  assert.deepEqual(config.modelCache, {
    rootPath: "/var/lib/gpulink/models",
    manifestPath: "/var/lib/gpulink/models/manifest.json",
  });
  assert.deepEqual(config.benchmark, {
    pythonPath: "/opt/gpulink/runtime/benchmark/bin/python",
    timeoutMs: 60_000,
  });
});

test("rejects unsafe benchmark runtime configuration", () => {
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      GPULINK_BENCHMARK_PYTHON: "./python",
    }),
    /must be an absolute path/u,
  );
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      GPULINK_BENCHMARK_TIMEOUT_MS: "120001",
    }),
    /must be at most 120000/u,
  );
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      GPULINK_MODEL_CACHE_ROOT: "./models",
    }),
    /must be an absolute path/u,
  );
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      GPULINK_WORKER_MODEL_INVENTORY_INTERVAL_MS: "3600001",
    }),
    /must be at most 3600000/u,
  );
});
