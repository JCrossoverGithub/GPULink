import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionAdapterRegistry,
  selectSessionHandler,
} from "../src/worker/session-adapters.mjs";

const CAPABILITY = "speech.streaming";
const MULTI = "speech.streaming.multitalker";
const SINGLE = "speech.streaming.single";

function adapter(id, result) {
  return {
    manifest: {
      schemaVersion: 2,
      type: CAPABILITY,
      adapterId: id,
      version: "1.0.0",
      executionMode: "streaming-gateway",
    },
    handleSession: () => result,
    readinessProbe: async () => true,
  };
}

const registry = createSessionAdapterRegistry([
  adapter(SINGLE, "single"),
  adapter(MULTI, "multitalker"),
]);

function select({
  adapterId = null,
  capability = CAPABILITY,
  ready = [MULTI, SINGLE],
  legacyHandler = null,
} = {}) {
  return selectSessionHandler({
    session: {
      capability,
      requirements: { adapter: adapterId },
    },
    registry,
    readyIds: new Set(ready),
    legacyHandler,
  });
}

test("pinned session selects exact implementation", () => {
  assert.equal(
    select({ adapterId: MULTI })?.(),
    "multitalker",
  );
});

test("pinned session rejects capability mismatch", () => {
  assert.equal(
    select({
      adapterId: MULTI,
      capability: "diagnostic.echo",
    }),
    null,
  );
});

test("unready pinned adapter never falls back", () => {
  assert.equal(
    select({
      adapterId: MULTI,
      ready: [SINGLE],
      legacyHandler: () => "legacy",
    }),
    null,
  );
});

test("unknown pinned adapter never falls back", () => {
  assert.equal(
    select({
      adapterId: "speech.streaming.unknown",
      legacyHandler: () => "legacy",
    }),
    null,
  );
});

test("unpinned session selects ready adapter", () => {
  assert.equal(
    select({ ready: [SINGLE] })?.(),
    "single",
  );
});

test("unpinned selection is deterministic", () => {
  assert.equal(select()?.(), "multitalker");
});

test("legacy callback remains available", () => {
  const legacy = () => "legacy";

  assert.equal(
    select({
      capability: "diagnostic.echo",
      legacyHandler: legacy,
    }),
    legacy,
  );
});
