import path from "node:path";

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedPositiveInteger(
  value,
  fallback,
  name,
  maximum,
) {
  const parsed =
    positiveInteger(
      value,
      fallback,
      name,
    );

  if (parsed > maximum) {
    throw new Error(
      `${name} must be at most ${maximum}`,
    );
  }

  return parsed;
}

export function loadControlPlaneConfig(environment = process.env) {
  const clientToken = requireToken(environment.GPULINK_CLIENT_TOKEN, "GPULINK_CLIENT_TOKEN");
  const workerToken = requireToken(environment.GPULINK_WORKER_TOKEN, "GPULINK_WORKER_TOKEN");
  const adminToken = requireToken(environment.GPULINK_ADMIN_TOKEN, "GPULINK_ADMIN_TOKEN");
  const dataPlaneSigningKey = requireToken(
    environment.GPULINK_DATA_PLANE_SIGNING_KEY,
    "GPULINK_DATA_PLANE_SIGNING_KEY",
  );

  if (
    new Set([
      clientToken,
      workerToken,
      adminToken,
      dataPlaneSigningKey,
    ]).size !== 4
  ) {
    throw new Error(
      "GPUlink control-plane tokens and data-plane signing key must all be different",
    );
  }

  const database =
    environment.GPULINK_CONTROL_DATABASE
      ?.trim()
      .toLowerCase() ||
    "sqlite";

  if (
    database !== "sqlite" &&
    database !== "postgres"
  ) {
    throw new Error(
      "GPULINK_CONTROL_DATABASE must be sqlite or postgres",
    );
  }

  const databaseUrl =
    environment.GPULINK_DATABASE_URL
      ?.trim() ||
    null;

  if (
    database === "postgres" &&
    !databaseUrl
  ) {
    throw new Error(
      "GPULINK_DATABASE_URL is required when GPULINK_CONTROL_DATABASE=postgres",
    );
  }

  return Object.freeze({
    host: environment.GPULINK_CONTROL_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment.GPULINK_CONTROL_PORT, 8088, "GPULINK_CONTROL_PORT"),
    database,
    databaseUrl,
    dataPath: path.resolve(
      environment.GPULINK_CONTROL_DATA_PATH?.trim() || "./data/control-plane.sqlite",
    ),
    tokens: Object.freeze({ client: clientToken, worker: workerToken, admin: adminToken }),
    dataPlaneSigningKey,
    dataPlaneGrantTtlMs:
      boundedPositiveInteger(
        environment.GPULINK_DATA_PLANE_GRANT_TTL_MS,
        15_000,
        "GPULINK_DATA_PLANE_GRANT_TTL_MS",
        60_000,
      ),
    heartbeatTimeoutMs: positiveInteger(
      environment.GPULINK_CONTROL_HEARTBEAT_TIMEOUT_MS,
      15_000,
      "GPULINK_CONTROL_HEARTBEAT_TIMEOUT_MS",
    ),
    leaseDurationMs: positiveInteger(
      environment.GPULINK_CONTROL_LEASE_DURATION_MS,
      30_000,
      "GPULINK_CONTROL_LEASE_DURATION_MS",
    ),
    schedulerIntervalMs: positiveInteger(
      environment.GPULINK_CONTROL_SCHEDULER_INTERVAL_MS,
      1_000,
      "GPULINK_CONTROL_SCHEDULER_INTERVAL_MS",
    ),
    vramSafetyMiB: positiveInteger(
      environment.GPULINK_CONTROL_VRAM_SAFETY_MIB,
      512,
      "GPULINK_CONTROL_VRAM_SAFETY_MIB",
    ),
  });
}

function requireToken(value, name) {
  const token = value?.trim();
  if (!token || token.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return token;
}
