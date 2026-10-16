/**
 * Operator-approved, SHA-256-pinned single-file ESM session adapter loader.
 *
 * This is an explicitly TRUSTED-CODE mechanism, not a sandbox. Modules run
 * with the worker's privileges. Never load entries from client requests.
 */
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_CATALOG_BYTES = 65_536;
const MAX_ENTRY_BYTES = 262_144;
const MAX_ADAPTERS = 64;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const keySet = (value) => Object.keys(value).sort().join(",");

function invalid(code) {
  const error = new Error(`Approved session adapter catalog: ${code}`);
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && keySet(value) === [...keys].sort().join(",");
}

function validPath(filePath) {
  return typeof filePath === "string" &&
    path.isAbsolute(filePath) &&
    !filePath.includes("\0") &&
    filePath.length <= 4096;
}

async function readPinnedFile(filePath, byteLimit) {
  if (!validPath(filePath)) throw invalid("absolute_path_required");
  // Windows does not expose POSIX O_NOFOLLOW. Reject a leaf symlink
  // before opening a trusted operator-controlled file. This is not a
  // race-free replacement for Linux O_NOFOLLOW: directories and catalogs
  // must remain protected from untrusted modifications by the operator.
  if (process.platform === "win32" && (await lstat(filePath)).isSymbolicLink()) {
    throw invalid("symlink_disallowed");
  }
  // O_NOFOLLOW rejects a symlink in the leaf file component on Linux.
  const fd = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > byteLimit) {
      throw invalid("invalid_file_size_or_type");
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if ((stat.mode & 0o022) !== 0 ||
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) {
        throw invalid("unsafe_file_owner_or_permissions");
      }
    }
    const bytes = await fd.readFile();
    if (bytes.length !== stat.size || bytes.length > byteLimit) {
      throw invalid("file_changed_during_read");
    }
    return bytes;
  } finally {
    await fd.close();
  }
}

function parseJson(bytes) {
  try {
    // Fatal UTF-8 decoding prevents different interpretations of pinned input.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("invalid_catalog_json");
  }
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, [
    "schemaVersion", "type", "adapterId", "version", "executionMode",
  ]) || manifest.schemaVersion !== 2 ||
    manifest.executionMode !== "streaming-gateway" ||
    [manifest.type, manifest.adapterId, manifest.version].some(
      (part) => typeof part !== "string" || part.length < 1 || part.length > 200,
    )) {
    throw invalid("invalid_adapter_manifest");
  }
}

function validateCatalog(catalog) {
  if (!exactKeys(catalog, ["schemaVersion", "adapters"]) ||
    catalog.schemaVersion !== 1 || !Array.isArray(catalog.adapters) ||
    catalog.adapters.length > MAX_ADAPTERS) {
    throw invalid("invalid_catalog_schema");
  }
  const identities = new Set();
  for (const spec of catalog.adapters) {
    if (!exactKeys(spec, ["manifest", "entrypoint", "sha256"])) {
      throw invalid("invalid_adapter_specification");
    }
    validateManifest(spec.manifest);
    if (!validPath(spec.entrypoint) ||
      typeof spec.sha256 !== "string" ||
      !sha256Pattern.test(spec.sha256)) {
      throw invalid("invalid_entrypoint_or_digest");
    }
    if (identities.has(spec.manifest.adapterId)) {
      throw invalid("duplicate_adapter_identity");
    }
    identities.add(spec.manifest.adapterId);
  }
  return catalog.adapters;
}

function identicalManifest(expected, actual) {
  return exactKeys(actual, [
    "schemaVersion", "type", "adapterId", "version", "executionMode",
  ]) && Object.keys(expected).every((key) => actual[key] === expected[key]);
}

/**
 * Returns an array accepted by WorkerAgent({ ... }, { sessionAdapters }).
 * Only the OPERATOR may choose catalogPath. An empty path disables loading.
 */
export async function loadApprovedSessionAdapters(catalogPath = null) {
  if (catalogPath === null) return [];
  const specs = validateCatalog(parseJson(
    await readPinnedFile(catalogPath, MAX_CATALOG_BYTES),
  ));

  // Verify the complete catalog before evaluating ANY adapter module.
  const verified = [];
  for (const spec of specs) {
    const bytes = await readPinnedFile(spec.entrypoint, MAX_ENTRY_BYTES);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== spec.sha256) throw invalid("entrypoint_digest_mismatch");
    verified.push({ spec, bytes });
  }

  const adapters = [];
  for (const { spec, bytes } of verified) {
    // Import exactly the verified bytes, rather than re-opening a mutable path.
    // Single-file ESM: relative imports are deliberately not supported in DP3B.
    const namespace = await import(
      `data:text/javascript;base64,${bytes.toString("base64")}`
    );
    if (typeof namespace.createAdapter !== "function") {
      throw invalid("create_adapter_export_required");
    }
    const adapter = await namespace.createAdapter();
    if (!record(adapter) ||
      !identicalManifest(spec.manifest, adapter.manifest) ||
      typeof adapter.readinessProbe !== "function" ||
      typeof adapter.handleSession !== "function") {
      throw invalid("adapter_contract_mismatch");
    }
    adapters.push(Object.freeze({
      manifest: Object.freeze({ ...spec.manifest }),
      readinessProbe: adapter.readinessProbe.bind(adapter),
      handleSession: adapter.handleSession.bind(adapter),
    }));
  }
  return adapters;
}
