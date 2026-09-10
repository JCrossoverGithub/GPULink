import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validateModelInventory,
  validateModelInventoryEntry,
} from "../src/shared/model-inventory.mjs";
import { discoverModelInventory } from "../src/worker/model-cache.mjs";
import { createTestContext, gpu } from "./helpers.mjs";

const cachedModel = Object.freeze({
  schemaVersion: 1,
  modelId: "nvidia/parakeet-tdt-0.6b-v2",
  revision: "main",
  adapterType: "speech.streaming",
});

test("validates, sorts, and bounds public model inventories", () => {
  assert.deepEqual(validateModelInventoryEntry(cachedModel), cachedModel);
  assert.deepEqual(validateModelInventory([
    { ...cachedModel, modelId: "z/model" },
    cachedModel,
  ]).map((entry) => entry.modelId), [
    "nvidia/parakeet-tdt-0.6b-v2",
    "z/model",
  ]);

  assert.throws(
    () => validateModelInventoryEntry({ ...cachedModel, relativePath: "private/path" }),
    /unexpected field relativePath/u,
  );
  assert.throws(
    () => validateModelInventory([cachedModel, cachedModel]),
    /duplicate modelId/u,
  );
  assert.throws(
    () => validateModelInventoryEntry({ ...cachedModel, modelId: "bad model" }),
    /unsupported characters/u,
  );
});

test("discovers only verified cache entries and omits local paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpulink-model-cache-"));
  const cacheRoot = path.join(directory, "models");
  const manifestPath = path.join(cacheRoot, "manifest.json");
  try {
    assert.deepEqual(await discoverModelInventory({ manifestPath, cacheRoot }), []);
    await mkdir(path.join(cacheRoot, "parakeet"), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      models: [{
        modelId: cachedModel.modelId,
        revision: cachedModel.revision,
        adapterType: cachedModel.adapterType,
        relativePath: "parakeet",
      }],
    }));

    const inventory = await discoverModelInventory({ manifestPath, cacheRoot });
    assert.deepEqual(inventory, [cachedModel]);
    assert.equal("relativePath" in inventory[0], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects traversal and symlink escapes from the model cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpulink-model-cache-escape-"));
  const cacheRoot = path.join(directory, "models");
  const outside = path.join(directory, "outside");
  const manifestPath = path.join(cacheRoot, "manifest.json");
  try {
    await mkdir(cacheRoot);
    await mkdir(outside);
    await writeFile(manifestPath, manifestWithPath("../outside"));
    await assert.rejects(
      discoverModelInventory({ manifestPath, cacheRoot }),
      /escapes the model cache root/u,
    );

    await symlink(outside, path.join(cacheRoot, "linked"));
    await writeFile(manifestPath, manifestWithPath("linked"));
    await assert.rejects(
      discoverModelInventory({ manifestPath, cacheRoot }),
      /resolves outside the model cache root/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("control plane persists validated model inventory reports", async () => {
  const context = createTestContext();
  try {
    const worker = await context.service.registerWorker({
      name: "model-cache-worker",
      version: "test",
      labels: {},
      capabilities: ["diagnostic.echo"],
      warmModels: [],
      modelInventory: [cachedModel],
      gpus: [gpu({ uuid: "GPU-MODEL-CACHE", memoryTotalMiB: 24_576 })],
    });
    assert.deepEqual(worker.modelInventory, [cachedModel]);

    const heartbeat = await context.service.heartbeatWorker(worker.id, {
      capabilities: worker.capabilities,
      warmModels: [],
      modelInventory: [],
      gpus: worker.gpus,
    });
    assert.deepEqual(heartbeat.modelInventory, []);
  } finally {
    await context.close();
  }
});

function manifestWithPath(relativePath) {
  return JSON.stringify({
    schemaVersion: 1,
    models: [{
      modelId: cachedModel.modelId,
      revision: cachedModel.revision,
      adapterType: cachedModel.adapterType,
      relativePath,
    }],
  });
}
