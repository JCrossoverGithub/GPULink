import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  validateAdapterManifest,
  validateAdapterManifests,
} from "../src/shared/adapter-manifest.mjs";
import { ControlPlaneDatabase } from "../src/control-plane/database.mjs";
import { listAdapterManifests } from "../src/worker/adapters.mjs";
import { createTestContext, gpu } from "./helpers.mjs";

const echoManifest = Object.freeze({
  schemaVersion: 1,
  type: "diagnostic.echo",
  version: "1.0.0",
  executionMode: "in-process",
});

test("validates, sorts, and bounds adapter manifests", () => {
  assert.deepEqual(validateAdapterManifest(echoManifest), echoManifest);
  assert.deepEqual(validateAdapterManifests([
    { ...echoManifest, type: "diagnostic.gpu-status" },
    echoManifest,
  ]).map((manifest) => manifest.type), [
    "diagnostic.echo",
    "diagnostic.gpu-status",
  ]);

  assert.throws(
    () => validateAdapterManifest({ ...echoManifest, version: "latest" }),
    /must be a semantic version/u,
  );
  assert.throws(
    () => validateAdapterManifest({ ...echoManifest, executionMode: "shell" }),
    /must be one of/u,
  );
  assert.throws(
    () => validateAdapterManifests([echoManifest, echoManifest]),
    /duplicate type diagnostic\.echo/u,
  );
});

test("worker adapter catalog describes only installed requested adapters", () => {
  assert.deepEqual(listAdapterManifests([
    "speech.streaming",
    "benchmark.gpu",
    "diagnostic.echo",
  ]), [
    {
      schemaVersion: 1,
      type: "benchmark.gpu",
      version: "1.0.0",
      executionMode: "bounded-process",
    },
    echoManifest,
  ]);
});

test("control plane persists manifests that match advertised capabilities", async () => {
  const context = createTestContext();
  try {
    const worker = await context.service.registerWorker({
      name: "manifest-worker",
      version: "test",
      labels: {},
      capabilities: ["diagnostic.echo"],
      adapterManifests: [echoManifest],
      warmModels: [],
      gpus: [gpu({ uuid: "GPU-MANIFEST", memoryTotalMiB: 8_192 })],
    });
    assert.deepEqual(worker.adapterManifests, [echoManifest]);

    await assert.rejects(
      () => context.service.heartbeatWorker(worker.id, {
        capabilities: [],
        adapterManifests: [echoManifest],
        warmModels: [],
        gpus: worker.gpus,
      }),
      /must match an advertised capability/u,
    );
  } finally {
    await context.close();
  }
});

test("database migration backfills empty manifests for existing workers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpulink-manifest-migration-"));
  const filename = path.join(directory, "control-plane.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        base_url TEXT,
        status TEXT NOT NULL CHECK(status IN ('online', 'offline')),
        drain_mode INTEGER NOT NULL DEFAULT 0 CHECK(drain_mode IN (0, 1)),
        labels_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        warm_models_json TEXT NOT NULL,
        gpu_inventory_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workers VALUES (
        'worker-legacy', 'legacy', '0.1.0', NULL, 'offline', 0,
        '{}', '["diagnostic.echo"]', '[]', '[]', 1, 1, 1
      );
    `);
    legacy.close();

    const migrated = new ControlPlaneDatabase(filename);
    assert.deepEqual(migrated.getWorker("worker-legacy").adapterManifests, []);
    assert.deepEqual(migrated.getWorker("worker-legacy").adapterHealth, []);
    assert.deepEqual(migrated.getWorker("worker-legacy").modelInventory, []);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
