import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAdapterManifests,
} from "../src/shared/adapter-manifest.mjs";

import {
  validateAdapterHealth,
} from "../src/shared/adapter-health.mjs";

const v1Manifest = {
  schemaVersion: 1,
  type: "diagnostic.echo",
  version: "1.0.0",
  executionMode: "in-process",
};

const v1Health = {
  schemaVersion: 1,
  type: "diagnostic.echo",
  state: "ready",
  code: "ready",
  checkedAt: 1000000,
};

const adapterIds = [
  "speech.streaming.multitalker",
  "speech.streaming.single",
];

const manifests = adapterIds.map((adapterId) => ({
  schemaVersion: 2,
  type: "speech.streaming",
  adapterId,
  version: "1.0.0",
  executionMode: "streaming-gateway",
}));

const healthReports = adapterIds.map((adapterId) => ({
  schemaVersion: 2,
  type: "speech.streaming",
  adapterId,
  state: "ready",
  code: "ready",
  checkedAt: 1000000,
}));

test("v1 adapter contracts remain backward-compatible", () => {
  assert.deepEqual(
    validateAdapterManifests([v1Manifest]),
    [v1Manifest],
  );

  assert.deepEqual(
    validateAdapterHealth([v1Health]),
    [v1Health],
  );
});

test("v2 supports multiple implementations of one capability", () => {
  let validated;

  assert.doesNotThrow(() => {
    validated = validateAdapterManifests(manifests);
  });

  assert.deepEqual(
    validated.map((entry) => entry.adapterId),
    adapterIds,
  );

  assert.deepEqual(
    validated.map((entry) => entry.type),
    ["speech.streaming", "speech.streaming"],
  );
});

test("v2 health identifies readiness per implementation", () => {
  let validated;

  assert.doesNotThrow(() => {
    validated = validateAdapterHealth(healthReports);
  });

  assert.deepEqual(
    validated.map((entry) => entry.adapterId),
    adapterIds,
  );

  assert.deepEqual(
    validated.map((entry) => entry.state),
    ["ready", "ready"],
  );
});


test("v2 identities have deterministic ordering", () => {
  assert.deepEqual(
    validateAdapterManifests([...manifests].reverse())
      .map((entry) => entry.adapterId),
    adapterIds,
  );

  assert.deepEqual(
    validateAdapterHealth([...healthReports].reverse())
      .map((entry) => entry.adapterId),
    adapterIds,
  );
});

test("duplicate adapter identities and mixed versions fail closed", () => {
  assert.throws(
    () => validateAdapterManifests([manifests[0], manifests[0]]),
    /duplicate adapterId/u,
  );

  assert.throws(
    () => validateAdapterHealth([healthReports[0], healthReports[0]]),
    /duplicate adapterId/u,
  );

  assert.throws(
    () => validateAdapterManifests([
      { ...v1Manifest, type: "speech.streaming" },
      manifests[0],
    ]),
    /cannot mix v1 and v2/u,
  );

  assert.throws(
    () => validateAdapterHealth([
      { ...v1Health, type: "speech.streaming" },
      healthReports[0],
    ]),
    /cannot mix v1 and v2/u,
  );
});

test("v1 remains strict and v2 requires valid identities", () => {
  assert.throws(
    () => validateAdapterManifests([
      { ...v1Manifest, adapterId: "diagnostic.echo" },
    ]),
    /unexpected field adapterId/u,
  );

  assert.throws(
    () => validateAdapterHealth([
      { ...v1Health, adapterId: "diagnostic.echo" },
    ]),
    /unexpected field adapterId/u,
  );

  assert.throws(
    () => validateAdapterManifests([
      { ...manifests[0], adapterId: "invalid adapter id" },
    ]),
    /adapterId contains unsupported characters/u,
  );

  assert.throws(
    () => validateAdapterHealth([
      { ...healthReports[0], adapterId: "invalid adapter id" },
    ]),
    /adapterId contains unsupported characters/u,
  );

  assert.throws(
    () => validateAdapterManifests([
      { ...manifests[0], adapterId: undefined },
    ]),
    /adapterId/u,
  );

  assert.throws(
    () => validateAdapterHealth([
      { ...healthReports[0], schemaVersion: 3 },
    ]),
    /schemaVersion/u,
  );
});
