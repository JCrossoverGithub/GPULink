import { accessSync, constants } from "node:fs";
import path from "node:path";
import { loadControlPlaneConfig } from "../control-plane/config.mjs";
import { loadWorkerConfig } from "../worker/config.mjs";

const minCredentialLength = 32;
const supportedRoles = new Set(["control-plane", "worker"]);

function check(name, status, action) {
  return { name, status, action };
}

function credentialPresent(environment, name) {
  return (environment[name]?.trim().length ?? 0) >= minCredentialLength;
}

function endpointCheck(value, fallback, label) {
  try {
    const url = new URL(value?.trim() || fallback);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) {
      return check(label, "FAIL", "Use an origin without embedded credentials, query or fragment.");
    }
    if (url.protocol === "https:") {
      return check(label, "PASS", "HTTPS origin configured; certificate trust is not verified offline.");
    }
    if (url.protocol === "http:" && loopback) {
      return check(label, "PASS", "Loopback HTTP configured for a local-only connection.");
    }
    return check(label, "FAIL", "Use trusted HTTPS for non-loopback connections; HTTP is only appropriate on loopback.");
  } catch {
    return check(label, "FAIL", "Provide a valid HTTP(S) origin without credentials.");
  }
}

function catalogCheck(environment, key) {
  const value = environment[key]?.trim();
  if (!value) return check(key, "WARN", "Not configured; this optional approved adapter catalog is disabled.");
  if (!path.isAbsolute(value)) return check(key, "FAIL", "Use an absolute catalog file path.");
  try {
    accessSync(value, constants.R_OK);
    return check(key, "PASS", "Catalog file is readable; approval hashes are not validated by this check.");
  } catch {
    return check(key, "FAIL", "Catalog is not readable by this user; check the path and permissions.");
  }
}

export function inspectRole(role, environment = process.env, { nodeMajor = Number(process.versions.node.split(".")[0]) } = {}) {
  if (!supportedRoles.has(role)) return null;
  const checks = [check("Node.js", nodeMajor >= 24 ? "PASS" : "FAIL", "GPULink Core requires Node.js 24 or newer.")];

  if (role === "worker") {
    checks.push(check("GPULINK_WORKER_NAME", environment.GPULINK_WORKER_NAME?.trim() ? "PASS" : "FAIL", "Supply a nonempty worker name."));
    checks.push(check("GPULINK_WORKER_TOKEN", credentialPresent(environment, "GPULINK_WORKER_TOKEN") ? "PASS" : "FAIL", "Supply a worker-scoped credential of at least 32 characters."));
    checks.push(endpointCheck(environment.GPULINK_CONTROL_PLANE_URL, "http://127.0.0.1:8088", "Worker control-plane origin"));
    checks.push(catalogCheck(environment, "GPULINK_APPROVED_ADAPTERS_CATALOG_PATH"));
    checks.push(catalogCheck(environment, "GPULINK_APPROVED_SUBPROCESS_CATALOG_PATH"));
    if (environment.GPULINK_WORKER_FAKE_GPU_JSON?.trim()) {
      checks.push(check("GPU inventory", "WARN", "Synthetic GPU configuration is set; this does not establish physical GPU availability."));
    }
    try {
      loadWorkerConfig(environment);
      checks.push(check("Worker config parser", "PASS", "Existing GPULink worker configuration parser accepted the settings."));
    } catch {
      checks.push(check("Worker config parser", "FAIL", "The worker rejected its configuration; review worker settings and JSON variables."));
    }
  } else {
    const names = ["GPULINK_CLIENT_TOKEN", "GPULINK_WORKER_TOKEN", "GPULINK_ADMIN_TOKEN", "GPULINK_DATA_PLANE_SIGNING_KEY"];
    for (const name of names) {
      checks.push(check(name, credentialPresent(environment, name) ? "PASS" : "FAIL", "Provide a separate secret of at least 32 characters."));
    }
    const values = names.map((name) => environment[name]?.trim());
    checks.push(check("Credential separation", values.every((value) => value?.length >= minCredentialLength) && new Set(values).size === 4 ? "PASS" : "FAIL", "Use distinct client, worker, admin, and signing credentials."));
    const database = environment.GPULINK_CONTROL_DATABASE?.trim().toLowerCase() || "sqlite";
    checks.push(check("Database selection", ["sqlite", "postgres"].includes(database) && (database !== "postgres" || Boolean(environment.GPULINK_DATABASE_URL?.trim())) ? "PASS" : "FAIL", "Select sqlite or postgres; postgres requires GPULINK_DATABASE_URL."));
    const host = environment.GPULINK_CONTROL_HOST?.trim() || "127.0.0.1";
    checks.push(check("Control-plane bind", ["127.0.0.1", "localhost", "::1"].includes(host) ? "PASS" : "WARN", "Non-loopback bind: confirm firewall, authentication, and trusted TLS termination before accepting remote clients."));
    try {
      loadControlPlaneConfig(environment);
      checks.push(check("Control-plane config parser", "PASS", "Existing GPULink control-plane configuration parser accepted the settings."));
    } catch {
      checks.push(check("Control-plane config parser", "FAIL", "The control plane rejected its configuration; review database, broker, port, and timeout settings."));
    }
  }
  return { role, checks, ok: !checks.some((result) => result.status === "FAIL") };
}

export function runDoctor(args, environment = process.env, output = console, options) {
  if (args.length !== 1 || !supportedRoles.has(args[0])) {
    output.error("Usage: npm run cli -- doctor <control-plane|worker>");
    output.error("Offline, read-only configuration checks only; no endpoints contacted, secrets printed, or GPU allocation attempted.");
    return 2;
  }
  const result = inspectRole(args[0], environment, options);
  output.log(`GPULink doctor (${result.role}; offline/read-only)`);
  for (const item of result.checks) {
    output.log(`${item.status}: ${item.name} — ${item.action}`);
  }
  output.log(result.ok ? "RESULT: Configuration preflight passed (not runtime or GPU readiness)." : "RESULT: Configuration preflight failed; no changes made.");
  return result.ok ? 0 : 1;
}
