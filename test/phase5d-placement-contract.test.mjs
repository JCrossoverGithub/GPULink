import assert from "node:assert/strict";
import test from "node:test";

import {
  choosePlacement,
} from "../src/control-plane/scheduler.mjs";

const NOW = 1_000_000;

const schedulerOptions = {
  now: NOW,
  heartbeatTimeoutMs: 60_000,
  vramSafetyMiB: 512,
};

function worker(id, capability, {
  utilizationPercent = 10,
  modelInventory = [],
  adapterManifests = [],
  adapterHealth = [],
} = {}) {
  return {
    id,
    status: "online",
    drainMode: false,
    lastSeenAt: NOW,
    capabilities: [capability],
    adapterManifests,
    adapterHealth,
    warmModels: [],
    modelInventory,
    gpus: [{
      uuid: `GPU-${id}`,
      memoryTotalMiB: 24_576,
      memoryUsedMiB: 0,
      utilizationPercent,
    }],
  };
}

test(
  "requested session adapter must not match an unidentified v1 implementation",
  () => {
    const candidate = worker(
      "legacy-worker",
      "speech.streaming",
      {
        adapterManifests: [{
          schemaVersion: 1,
          type: "speech.streaming",
          version: "1.0.0",
          executionMode: "streaming-gateway",
        }],
        adapterHealth: [{
          schemaVersion: 1,
          type: "speech.streaming",
          state: "ready",
          code: "ready",
          checkedAt: NOW,
        }],
      },
    );

    const placement = choosePlacement(
      {
        capability: "speech.streaming",
        requirements: {
          gpuCount: 1,
          minVramMiB: 4096,
          capabilities: ["speech.streaming"],
          model: null,
          adapter: "speech.streaming.multitalker",
        },
      },
      [candidate],
      new Set(),
      schedulerOptions,
    );

    assert.equal(
      placement,
      null,
      "v1 capability readiness does not prove a specific adapter identity",
    );
  },
);

test(
  "cached model must not outrank a compatible worker using unrelated adapter inventory",
  () => {
    const wrongCache = worker(
      "wrong-cache",
      "diagnostic.echo",
      {
        utilizationPercent: 10,
        modelInventory: [{
          schemaVersion: 1,
          modelId: "example/model",
          revision: "v1",
          adapterType: "speech.streaming",
        }],
      },
    );

    const compatible = worker(
      "compatible-worker",
      "diagnostic.echo",
      {
        utilizationPercent: 1,
      },
    );

    const placement = choosePlacement(
      {
        type: "diagnostic.echo",
        constraints: {
          gpuCount: 1,
          minVramMiB: 1000,
          capabilities: ["diagnostic.echo"],
          model: "example/model",
        },
      },
      [wrongCache, compatible],
      new Set(),
      schedulerOptions,
    );

    assert.equal(
      placement?.workerId,
      "compatible-worker",
      "unrelated cached-model inventory must not receive locality preference",
    );
  },
);
