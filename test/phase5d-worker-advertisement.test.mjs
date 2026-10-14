import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestContext,
  gpu,
} from "./helpers.mjs";

const CAPABILITY = "speech.streaming";

const IDS = [
  "speech.streaming.multitalker",
  "speech.streaming.single",
];

function manifest(adapterId) {
  return {
    schemaVersion: 2,
    type: CAPABILITY,
    adapterId,
    version: "1.0.0",
    executionMode: "streaming-gateway",
  };
}

function health(adapterId, checkedAt) {
  return {
    schemaVersion: 2,
    type: CAPABILITY,
    adapterId,
    state: "ready",
    code: "ready",
    checkedAt,
  };
}

function advertisement(checkedAt) {
  return {
    name: "phase5d-worker",
    version: "test",
    labels: {},
    capabilities: [CAPABILITY],
    adapterManifests: IDS.map(manifest),
    adapterHealth: IDS.map(
      (id) => health(id, checkedAt),
    ),
    warmModels: [],
    modelInventory: [],
    gpus: [
      gpu({
        uuid: "GPU-PHASE5D",
        memoryTotalMiB: 24576,
      }),
    ],
  };
}

test(
  "consistent v2 implementations register successfully",
  async () => {
    const context = createTestContext();

    try {
      const worker = await context.service.registerWorker(
        advertisement(context.clock()),
      );

      assert.deepEqual(
        worker.adapterManifests.map(
          (entry) => entry.adapterId,
        ),
        IDS,
      );

      assert.deepEqual(
        worker.adapterHealth.map(
          (entry) => entry.adapterId,
        ),
        IDS,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "registration rejects missing implementation health",
  async () => {
    const context = createTestContext();

    try {
      const input = advertisement(context.clock());

      input.adapterHealth =
        input.adapterHealth.slice(0, 1);

      await assert.rejects(
        () => context.service.registerWorker(input),
        /adapter/i,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "heartbeat rejects a mismatched implementation identity",
  async () => {
    const context = createTestContext();

    try {
      const input = advertisement(context.clock());

      const worker =
        await context.service.registerWorker(input);

      const heartbeat = {
        capabilities: input.capabilities,
        adapterManifests: input.adapterManifests,
        adapterHealth: [
          health(IDS[0], context.clock()),
          health(
            "speech.streaming.unknown",
            context.clock(),
          ),
        ],
        warmModels: [],
        modelInventory: [],
        gpus: input.gpus,
      };

      await assert.rejects(
        () => context.service.heartbeatWorker(
          worker.id,
          heartbeat,
        ),
        /adapter/i,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "registration rejects v1 manifest with v2 health",
  async () => {
    const context = createTestContext();

    try {
      const input = advertisement(context.clock());

      input.adapterManifests = [{
        schemaVersion: 1,
        type: CAPABILITY,
        version: "1.0.0",
        executionMode: "streaming-gateway",
      }];

      input.adapterHealth = [
        health(IDS[0], context.clock()),
      ];

      await assert.rejects(
        () => context.service.registerWorker(input),
        /adapter/i,
      );
    } finally {
      await context.close();
    }
  },
);
