import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_LIFECYCLE_STATES,
  SESSION_MAX_INTERRUPTIONS,
  SESSION_SCHEMA_VERSION,
  validateSessionRequest,
} from "../src/shared/session-contract.mjs";

test("normalizes a minimal generic session request", () => {
  assert.deepEqual(
    validateSessionRequest({
      projectId: "example-project",
      capability: "speech.streaming",
    }),
    {
      schemaVersion: 1,
      projectId: "example-project",
      capability: "speech.streaming",
      priority: 0,
      requirements: {
        gpuCount: 1,
        minVramMiB: 0,
        capabilities: [
          "speech.streaming",
        ],
        model: null,
        adapter: null,
      },
      metadata: {},
      recovery: {
        maxInterruptions: 0,
      },
    },
  );
});

test("normalizes explicit generic scheduling metadata", () => {
  assert.deepEqual(
    validateSessionRequest({
      schemaVersion:
        SESSION_SCHEMA_VERSION,
      projectId: "caption-client",
      capability: "speech.streaming",
      priority: 25,
      requirements: {
        gpuCount: 1,
        minVramMiB: 16_384,
        capabilities: [
          "speech.streaming",
          "speech.streaming",
          "diagnostic.gpu-status",
        ],
        model:
          "nvidia/parakeet-unified-en-0.6b",
        adapter:
          "speech.streaming.multitalker",
      },
      metadata: {
        protocol: "transgo-v1",
        client: {
          interimResults: true,
          frameDurationMs: 100,
        },
      },
      recovery: {
        maxInterruptions: 1,
      },
    }),
    {
      schemaVersion: 1,
      projectId: "caption-client",
      capability: "speech.streaming",
      priority: 25,
      requirements: {
        gpuCount: 1,
        minVramMiB: 16_384,
        capabilities: [
          "diagnostic.gpu-status",
          "speech.streaming",
        ],
        model:
          "nvidia/parakeet-unified-en-0.6b",
        adapter:
          "speech.streaming.multitalker",
      },
      metadata: {
        client: {
          frameDurationMs: 100,
          interimResults: true,
        },
        protocol: "transgo-v1",
      },
      recovery: {
        maxInterruptions: 1,
      },
    },
  );
});

test("session requests remain whole-GPU allocations", () => {
  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        requirements: {
          gpuCount: 2,
        },
      }),
    /session\.requirements\.gpuCount must be an integer between 1 and 1/u,
  );
});

test("primary capability must remain a hard requirement", () => {
  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        requirements: {
          capabilities: [
            "diagnostic.gpu-status",
          ],
        },
      }),
    /must include session\.capability/u,
  );
});

test("clients cannot select infrastructure or transport controls", () => {
  for (const field of [
    "workerId",
    "gpuUuid",
    "leaseId",
    "leaseDurationMs",
    "endpoint",
    "audioBytes",
  ]) {
    assert.throws(
      () =>
        validateSessionRequest({
          projectId: "test",
          capability: "speech.streaming",
          [field]: "forbidden",
        }),
      new RegExp(
        `unexpected field ${field}`,
        "u",
      ),
    );
  }
});

test("session recovery policy is bounded", () => {
  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        recovery: {
          maxInterruptions:
            SESSION_MAX_INTERRUPTIONS + 1,
        },
      }),
    /session\.recovery\.maxInterruptions must be an integer/u,
  );
});

test("application metadata is bounded and JSON-safe", () => {
  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        metadata: {
          value: Number.NaN,
        },
      }),
    /numbers must be finite/u,
  );

  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        metadata: {
          value: undefined,
        },
      }),
    /JSON-compatible values/u,
  );

  assert.throws(
    () =>
      validateSessionRequest({
        projectId: "test",
        capability: "speech.streaming",
        metadata: {
          payload: "x".repeat(9_000),
        },
      }),
    /at most 1000 characters/u,
  );
});

test("session lifecycle vocabulary is stable and generic", () => {
  assert.deepEqual(
    SESSION_LIFECYCLE_STATES,
    [
      "requested",
      "allocated",
      "connecting",
      "active",
      "interrupted",
      "closed",
    ],
  );
});
