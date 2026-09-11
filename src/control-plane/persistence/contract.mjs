export const PERSISTENCE_METHODS = Object.freeze([
  "upsertWorker",
  "updateWorkerHeartbeat",
  "setWorkerDrain",
  "listWorkers",
  "getWorker",
  "markStaleWorkersOffline",
  "insertJob",
  "getJob",
  "listJobs",
  "listQueuedJobs",
  "listActiveJobs",
  "assignJob",
  "startJob",
  "renewJob",
  "finishJob",
  "cancelJob",
  "recoverExpiredJobs",
  "appendEvent",
  "listEventsAfter",
  "counts",
]);

export const PERSISTENCE_CONTROL_METHODS = Object.freeze([
  "transaction",
  "subscribeToEvents",
  "close",
]);

export function assertPersistenceContract(
  persistence,
  name = "persistence",
) {
  if (
    persistence === null ||
    (typeof persistence !== "object" &&
      typeof persistence !== "function")
  ) {
    throw new TypeError(`${name} must be an object`);
  }

  for (const method of [
    ...PERSISTENCE_METHODS,
    ...PERSISTENCE_CONTROL_METHODS,
  ]) {
    if (typeof persistence[method] !== "function") {
      throw new TypeError(
        `${name}.${method} must be a function`,
      );
    }
  }

  return persistence;
}
