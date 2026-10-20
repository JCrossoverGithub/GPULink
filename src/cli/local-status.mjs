import { readLocalSmokeSetup } from "./local-smoke.mjs";
import { inspectLocalOwnershipCandidates } from "./local-process-ownership.mjs";
import { inspectManagedLocal } from "./local-lifecycle.mjs";

const TIMEOUT_MS = 2500;

function refused(error) {
  return error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED";
}

async function boundedReadyJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let data = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return null;
      data += decoder.decode(value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Credential-free observation of a generated loopback installation.
 * A response from a port is not proof of process identity or ownership.
 * Do not send client/admin/worker credentials until ownership is established.
 */
export async function inspectLocalStatus(setup, fetchImpl = fetch) {
  const control = setup.profiles["control-plane.env"];
  const base = `http://${control.GPULINK_CONTROL_HOST}:${control.GPULINK_CONTROL_PORT}`;
  const result = {
    schemaVersion: 1,
    scope: "single-machine-development",
    controlPlane: "unverified",
    localWorker: "unknown",
    processOwnership: "unverified",
  };

  let readiness;
  try {
    readiness = await fetchImpl(`${base}/readyz`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (refused(error)) return { ...result, controlPlane: "offline" };
    return result;
  }

  if (!readiness.ok) return result;
  try {
    const health = await boundedReadyJson(readiness);
    if (health?.status !== "ready") return result;
  } catch { return result; }
  // Another loopback process may mimic /readyz. This is NOT authenticated
  // readiness and must never authorize stop, worker claims or GPU execution.
  return { ...result, controlPlane: "ready-response-unverified" };
}

export async function runLocalStatus(args, selectedDirectory, { output = console, fetchImpl = fetch } = {}) {
  if (args.length !== 0) {
    output.error("Usage: gpulink [--config-dir DIRECTORY] local status");
    return 2;
  }
  if (!selectedDirectory) {
    output.error("No local installation selected. Run gpulink init local or specify --config-dir.");
    return 1;
  }
  let setup;
  try {
    setup = readLocalSmokeSetup(selectedDirectory);
  } catch {
    output.error("Local setup validation failed; no endpoint was contacted.");
    return 1;
  }
  const managed = await inspectManagedLocal(setup);
  const status = {
    ...await inspectLocalStatus(setup, fetchImpl),
    ownershipRecords: inspectLocalOwnershipCandidates(setup),
  };
  if (managed) {
    status.processOwnership = "managed-local";
    status.controlPlane = managed === "ready" && status.controlPlane === "ready-response-unverified"
      ? "ready-managed-local" : "starting-or-stopping-managed-local";
  }
  output.log(JSON.stringify(status, null, 2));
  // Offline is an observation; any occupied/unverified endpoint is unresolved.
  return ["offline", "ready-managed-local"].includes(status.controlPlane) ? 0 : 1;
}
