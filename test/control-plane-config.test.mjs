import assert from "node:assert/strict";
import test from "node:test";
import { loadControlPlaneConfig } from "../src/control-plane/config.mjs";

const validEnvironment = {
  GPULINK_CLIENT_TOKEN: "client-token-that-is-at-least-32-characters-long",
  GPULINK_WORKER_TOKEN: "worker-token-that-is-at-least-32-characters-long",
  GPULINK_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters-long",
  GPULINK_DATA_PLANE_SIGNING_KEY:
    "data-plane-signing-key-that-is-at-least-32-characters",
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
    /must all be different/u,
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

test(
  "loads bounded data-plane grant signing configuration",
  () => {
    const defaults =
      loadControlPlaneConfig(
        validEnvironment,
      );

    assert.equal(
      defaults.dataPlaneSigningKey,
      validEnvironment
        .GPULINK_DATA_PLANE_SIGNING_KEY,
    );

    assert.equal(
      defaults.dataPlaneGrantTtlMs,
      15_000,
    );

    const custom =
      loadControlPlaneConfig({
        ...validEnvironment,
        GPULINK_DATA_PLANE_GRANT_TTL_MS:
          "12000",
      });

    assert.equal(
      custom.dataPlaneGrantTtlMs,
      12_000,
    );

    assert.throws(
      () =>
        loadControlPlaneConfig({
          ...validEnvironment,
          GPULINK_DATA_PLANE_GRANT_TTL_MS:
            "60001",
        }),
      /must be at most 60000/u,
    );
  },
);

test(
  "rejects an unsafe data-plane signing key",
  () => {
    assert.throws(
      () =>
        loadControlPlaneConfig({
          ...validEnvironment,
          GPULINK_DATA_PLANE_SIGNING_KEY:
            "too-short",
        }),
      /at least 32 characters/u,
    );

    assert.throws(
      () =>
        loadControlPlaneConfig({
          ...validEnvironment,
          GPULINK_DATA_PLANE_SIGNING_KEY:
            validEnvironment
              .GPULINK_CLIENT_TOKEN,
        }),
      /must all be different/u,
    );
  },
);
