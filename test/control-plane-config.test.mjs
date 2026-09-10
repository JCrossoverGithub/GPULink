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

test("defaults the control plane to SQLite persistence", () => {
  const config =
    loadControlPlaneConfig(
      validEnvironment,
    );

  assert.equal(
    config.database,
    "sqlite",
  );

  assert.equal(
    config.databaseUrl,
    null,
  );
});

test("accepts explicit PostgreSQL persistence", () => {
  const databaseUrl =
    "postgresql://gpulink:test@127.0.0.1:5432/gpulink";

  const config =
    loadControlPlaneConfig({
      ...validEnvironment,
      GPULINK_CONTROL_DATABASE:
        "postgres",
      GPULINK_DATABASE_URL:
        databaseUrl,
    });

  assert.equal(
    config.database,
    "postgres",
  );

  assert.equal(
    config.databaseUrl,
    databaseUrl,
  );
});

test("requires a database URL for PostgreSQL persistence", () => {
  assert.throws(
    () =>
      loadControlPlaneConfig({
        ...validEnvironment,
        GPULINK_CONTROL_DATABASE:
          "postgres",
      }),
    /GPULINK_DATABASE_URL is required/u,
  );
});

test("rejects an unsupported persistence backend", () => {
  assert.throws(
    () =>
      loadControlPlaneConfig({
        ...validEnvironment,
        GPULINK_CONTROL_DATABASE:
          "mysql",
      }),
    /must be sqlite or postgres/u,
  );
});
