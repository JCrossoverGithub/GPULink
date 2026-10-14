import {
  validateAdapterManifest,
} from "../shared/adapter-manifest.mjs";

import {
  validateAdapterHealthReport,
} from "../shared/adapter-health.mjs";

export function createSessionAdapterRegistry(adapters = []) {
  if (!Array.isArray(adapters) || adapters.length > 64) {
    throw new TypeError(
      "sessionAdapters must be an array with at most 64 items",
    );
  }

  const registry = new Map();

  for (const [index, adapter] of adapters.entries()) {
    if (
      !adapter ||
      typeof adapter !== "object" ||
      Array.isArray(adapter)
    ) {
      throw new TypeError(
        `sessionAdapters[${index}] must be an object`,
      );
    }

    const manifest = validateAdapterManifest(
      adapter.manifest,
      `sessionAdapters[${index}].manifest`,
    );

    if (
      manifest.schemaVersion !== 2 ||
      manifest.executionMode !== "streaming-gateway"
    ) {
      throw new TypeError(
        "session adapter requires a v2 streaming-gateway manifest",
      );
    }

    if (typeof adapter.handleSession !== "function") {
      throw new TypeError(
        `session adapter ${manifest.adapterId} requires handleSession handler`,
      );
    }

    if (typeof adapter.readinessProbe !== "function") {
      throw new TypeError(
        `session adapter ${manifest.adapterId} requires readinessProbe`,
      );
    }

    if (registry.has(manifest.adapterId)) {
      throw new TypeError(
        `duplicate session adapter identity ${manifest.adapterId}`,
      );
    }

    registry.set(
      manifest.adapterId,
      Object.freeze({
        manifest,
        handleSession: adapter.handleSession.bind(adapter),
        readinessProbe: adapter.readinessProbe.bind(adapter),
      }),
    );
  }

  return new Map(
    [...registry.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
}

export async function probeSessionAdapters(
  registry,
  context = {},
  checkedAt = Date.now(),
  { timeoutMs = 5_000 } = {},
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new RangeError(
      "session adapter readiness timeout must be between 1 and 300000 milliseconds",
    );
  }

  // Begin each probe independently. A stalled adapter
  // must not delay the readiness result of another.
  const results = await Promise.all(
    [...registry.values()].map(async (adapter) => {
      let deadlineTimer;
      let ready = false;

      try {
        // Convert synchronous exceptions into rejections.
        const probe = Promise.resolve().then(
          () => adapter.readinessProbe(context),
        );

        const deadline = new Promise((resolve) => {
          deadlineTimer = setTimeout(
            () => resolve(false),
            timeoutMs,
          );
        });

        ready =
          (await Promise.race([
            probe,
            deadline,
          ])) === true;
      } catch {
        // Probe exceptions remain private to the worker.
        // Rejecting or timing out never certifies readiness.
      } finally {
        clearTimeout(deadlineTimer);
      }

      return { adapter, ready };
    }),
  );

  // Promise.all retains registry order regardless of
  // individual probe completion order.
  const capabilities = new Set();
  const adapterManifests = [];
  const adapterHealth = [];

  for (const { adapter, ready } of results) {
    const state = ready ? "ready" : "unavailable";

    adapterHealth.push(
      validateAdapterHealthReport({
        schemaVersion: 2,
        type: adapter.manifest.type,
        adapterId: adapter.manifest.adapterId,
        state,
        code: ready
          ? "ready"
          : "readiness_probe_failed",
        checkedAt,
      }),
    );

    if (ready) {
      capabilities.add(adapter.manifest.type);
      adapterManifests.push(adapter.manifest);
    }
  }

  return {
    capabilities: [...capabilities].sort(),
    adapterManifests,
    adapterHealth,
  };
}

export function selectSessionHandler({
  session,
  registry,
  readyIds,
  legacyHandler = null,
}) {
  const requestedId = session.requirements?.adapter ?? null;

  if (requestedId !== null) {
    const adapter = registry.get(requestedId);

    if (
      !adapter ||
      !readyIds.has(requestedId) ||
      adapter.manifest.type !== session.capability
    ) {
      return null;
    }

    return adapter.handleSession;
  }

  for (const [id, adapter] of [...registry.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (
      readyIds.has(id) &&
      adapter.manifest.type === session.capability
    ) {
      return adapter.handleSession;
    }
  }

  return typeof legacyHandler === "function"
    ? legacyHandler
    : null;
}
