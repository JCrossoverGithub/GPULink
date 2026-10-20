import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
} from "node:fs";
import path from "node:path";

// Local status may inspect these records, but MUST NOT treat them as permission
// to signal a PID, send a credential, or claim ownership of a listening port.
const RECORD_BYTES_MAX = 4096;
const ROLES = Object.freeze(["control-plane", "worker"]);
const HEX_64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGITS = /^[1-9][0-9]{0,24}$/u;

export function installationFingerprint(setup) {
  const key = setup?.profiles?.["control-plane.env"]?.GPULINK_DATA_PLANE_SIGNING_KEY;
  if (typeof key !== "string" || key.length < 32 || !path.isAbsolute(setup?.directory ?? "")) {
    throw new Error("Validated local setup required for ownership inspection.");
  }
  return createHash("sha256")
    .update("GPULINK_LOCAL_OWNERSHIP_V1\0", "utf8")
    .update(path.resolve(setup.directory), "utf8")
    .update("\0", "utf8")
    .update(key, "utf8")
    .digest("hex");
}

/** Strict process-birth marker read from the Linux kernel, NOT an ownership proof. */
export function parseLinuxProcessStart(stat) {
  if (typeof stat !== "string" || stat.length > 4096) return null;
  const closing = stat.lastIndexOf(")");
  if (closing < 2 || stat[closing + 1] !== " ") return null;
  const fields = stat.slice(closing + 2).trim().split(/\s+/u);
  // /proc/PID/stat: field 3 is fields[0]; field 22 is fields[19].
  if (fields.length < 20 || fields[0] === "Z" || fields[0] === "X") return null;
  return DIGITS.test(fields[19] ?? "") ? fields[19] : null;
}

export function observeLinuxBirth(pid, { read = readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647) return null;
  try {
    const bootId = String(read("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!UUID.test(bootId)) return null;
    const startTicks = parseLinuxProcessStart(String(read(`/proc/${pid}/stat`, "utf8")));
    return startTicks ? { bootId: bootId.toLowerCase(), startTicks } : null;
  } catch { return null; }
}

function exactly(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

// Schema for an eventual supervisor's private, atomic record. A matching
// process birth is still untrusted until a separate live owner challenge passes.
export function validateOwnershipRecord(record, setup, role) {
  if (!ROLES.includes(role) || !exactly(record, [
    "schemaVersion", "role", "installationFingerprint", "pid", "birth", "launchId",
  ])) return false;
  if (record.schemaVersion !== 1 || record.role !== role ||
      record.installationFingerprint !== installationFingerprint(setup) ||
      !Number.isSafeInteger(record.pid) || record.pid < 2 || record.pid > 2_147_483_647 ||
      typeof record.launchId !== "string" || !HEX_64.test(record.launchId) ||
      !exactly(record.birth, ["kind", "bootId", "startTicks"]) ||
      record.birth.kind !== "linux-procfs" || !UUID.test(record.birth.bootId) ||
      record.birth.bootId !== record.birth.bootId.toLowerCase() ||
      !DIGITS.test(record.birth.startTicks)) return false;
  return true;
}

function readPrivateRecord(filename) {
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > RECORD_BYTES_MAX ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0)) {
    throw new Error("Unsafe ownership record.");
  }
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size > RECORD_BYTES_MAX ||
        (process.platform !== "win32" && (opened.mode & 0o077) !== 0)) {
      throw new Error("Ownership record changed during inspection.");
    }
    const bytes = readFileSync(fd);
    if (bytes.length > RECORD_BYTES_MAX) throw new Error("Oversized ownership record.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
}

/**
 * Read-only, non-authoritative inspection. Never creates state or contacts a port.
 * Even matching kernel birth metadata does not authorize a signal or credential.
 */
export function inspectLocalOwnershipCandidates(setup, {
  platform = process.platform,
  observeBirth = observeLinuxBirth,
} = {}) {
  // Do not disclose the fingerprint, process IDs, launch IDs or paths in output.
  installationFingerprint(setup);
  const result = { controlPlane: "absent", worker: "absent", authority: "none" };
  const directory = path.join(setup.directory, "run");
  let metadata;
  try { metadata = lstatSync(directory); }
  catch (error) {
    if (error?.code === "ENOENT") return result;
    return { controlPlane: "unverifiable", worker: "unverifiable", authority: "none" };
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    return { controlPlane: "invalid", worker: "invalid", authority: "none" };
  }
  for (const role of ROLES) {
    const displayKey = role === "control-plane" ? "controlPlane" : "worker";
    const filename = path.join(directory, `${role}.owner.json`);
    let record;
    try { record = readPrivateRecord(filename); }
    catch (error) {
      result[displayKey] = error?.code === "ENOENT" ? "absent" : "invalid";
      continue;
    }
    if (!validateOwnershipRecord(record, setup, role)) {
      result[displayKey] = "invalid";
    } else if (platform !== "linux") {
      result[displayKey] = "unverifiable";
    } else {
      const birth = observeBirth(record.pid);
      if (!birth) result[displayKey] = "unverifiable";
      else if (birth.bootId !== record.birth.bootId || birth.startTicks !== record.birth.startTicks) {
        result[displayKey] = "stale";
      } else {
        result[displayKey] = "birth-matches-unverified";
      }
    }
  }
  return result;
}
