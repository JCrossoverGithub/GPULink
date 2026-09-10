import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterHealthReport,
  validateAdapterHealth,
  validateAdapterHealthReport,
} from "../src/shared/adapter-health.mjs";
import { resolveAdapterHealth } from "../src/worker/adapters.mjs";
import { createTestContext, gpu } from "./helpers.mjs";

const echoManifest = Object.freeze({
  schemaVersion: 1,
  type: "diagnostic.echo",
  version: "1.0.0",
  executionMode: "in-process",
});

test("validates bounded adapter health states without diagnostic text", () => {
  assert.deepEqual(
    adapterHealthReport("diagnostic.echo", "ready", 1_700_000_000_000),
    {
      schemaVersion: 1,
      type: "diagnostic.echo",
      state: "ready",
      code: "ready",
      checkedAt: 1_700_000_000_000,
    },
  );
  assert.deepEqual(validateAdapterHealth([
    adapterHealthReport("speech.streaming", "not-installed", 20),
    adapterHealthReport("benchmark.gpu", "unavailable", 20),
  ]).map((report) => report.type), ["benchmark.gpu", "speech.streaming"]);

  assert.throws(
    () => validateAdapterHealthReport({
      ...adapterHealthReport("benchmark.gpu", "unavailable", 20),
      message: "secret path or exception",
    }),
    /unexpected field message/u,
  );
  assert.throws(
    () => validateAdapterHealthReport({
      ...adapterHealthReport("benchmark.gpu", "unavailable", 20),
      code: "ready",
    }),
    /code must be readiness_probe_failed/u,
  );
});

test("resolves ready, unavailable, and uninstalled configured adapters", async () => {
  const report = await resolveAdapterHealth([
    "speech.streaming",
    "diagnostic.echo",
    "benchmark.gpu",
  ], {
    benchmark: { pythonPath: "/missing/python", timeoutMs: 60_000 },
    gpus: [{ uuid: "GPU-HEALTH", name: "Health Test GPU" }],
    fileAccess: async () => { throw new Error("private readiness detail"); },
  }, 123_456);

  assert.deepEqual(report.capabilities, ["diagnostic.echo"]);
  assert.deepEqual(report.adapterManifests, [echoManifest]);
  assert.deepEqual(report.adapterHealth, [
    adapterHealthReport("benchmark.gpu", "unavailable", 123_456),
    adapterHealthReport("diagnostic.echo", "ready", 123_456),
    adapterHealthReport("speech.streaming", "not-installed", 123_456),
  ]);
  assert.equal(JSON.stringify(report).includes("private readiness detail"), false);
});

test("control plane persists consistent adapter health and rejects contradictions", async () => {
  const context = createTestContext();
  try {
    const adapterHealth = [adapterHealthReport(
      "diagnostic.echo",
      "ready",
      context.clock(),
    )];
    const worker = await context.service.registerWorker({
      name: "healthy-worker",
      version: "test",
      labels: {},
      capabilities: ["diagnostic.echo"],
      adapterManifests: [echoManifest],
      adapterHealth,
      warmModels: [],
      gpus: [gpu({ uuid: "GPU-HEALTH-PERSIST", memoryTotalMiB: 8_192 })],
    });
    assert.deepEqual(worker.adapterHealth, adapterHealth);

    await assert.rejects(
      () => context.service.heartbeatWorker(worker.id, {
        capabilities: ["diagnostic.echo"],
        adapterManifests: [echoManifest],
        adapterHealth: [adapterHealthReport(
          "diagnostic.echo",
          "unavailable",
          context.clock(),
        )],
        warmModels: [],
        gpus: worker.gpus,
      }),
      /ready adapter health, manifests, and advertised capabilities must match/u,
    );
  } finally {
    await context.close();
  }
});
