import assert from "node:assert/strict";
import test from "node:test";
import { loadControlPlaneConfig } from "../src/control-plane/config.mjs";

const validEnvironment = {
  GPULINK_CLIENT_TOKEN: "client-token-that-is-at-least-32-characters-long",
  GPULINK_WORKER_TOKEN: "worker-token-that-is-at-least-32-characters-long",
  GPULINK_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters-long",
};

test("accepts three distinct scoped control-plane credentials", () => {
  const config = loadControlPlaneConfig(validEnvironment);

  assert.deepEqual(config.tokens, {
    client: validEnvironment.GPULINK_CLIENT_TOKEN,
    worker: validEnvironment.GPULINK_WORKER_TOKEN,
    admin: validEnvironment.GPULINK_ADMIN_TOKEN,
  });
});

test("rejects a short control-plane credential", () => {
  assert.throws(
    () => loadControlPlaneConfig({ ...validEnvironment, GPULINK_CLIENT_TOKEN: "too-short" }),
    /at least 32 characters/u,
  );
});

test("rejects credential reuse across scopes", () => {
  assert.throws(
    () => loadControlPlaneConfig({
      ...validEnvironment,
      GPULINK_WORKER_TOKEN: validEnvironment.GPULINK_CLIENT_TOKEN,
    }),
    /must be different/u,
  );
});
