import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_INVENTORY_SCHEMA_VERSION,
  validateModelInventory,
  validateModelInventoryEntry,
} from "../shared/model-inventory.mjs";
import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
} from "../shared/validation.mjs";

export const MAX_MODEL_CACHE_MANIFEST_BYTES = 65_536;

export async function discoverModelInventory({
  manifestPath,
  cacheRoot,
  fileStat = stat,
  fileRead = readFile,
  resolveRealPath = realpath,
} = {}) {
  try {
    requireAbsolutePath(manifestPath, "model cache manifest path");
    requireAbsolutePath(cacheRoot, "model cache root");
    let manifestStat;
    try {
      manifestStat = await fileStat(manifestPath);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!manifestStat.isFile() || manifestStat.size > MAX_MODEL_CACHE_MANIFEST_BYTES) {
      throw new Error("model cache manifest must be a regular file no larger than 64 KiB");
    }

    const text = await fileRead(manifestPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MODEL_CACHE_MANIFEST_BYTES) {
      throw new Error("model cache manifest exceeds 64 KiB");
    }
    const manifest = parseManifest(text);
    const realRoot = await resolveRealPath(cacheRoot);
    const inventory = [];
    for (const [index, value] of manifest.models.entries()) {
      const name = `model cache manifest.models[${index}]`;
      const localEntry = requireObject(value, name);
      rejectUnknownFields(localEntry, name, [
        "modelId",
        "revision",
        "adapterType",
        "relativePath",
      ]);
      const relativePath = requireString(
        localEntry.relativePath,
        `${name}.relativePath`,
        { maximum: 500 },
      );
      if (relativePath === "." || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
        throw new Error(`${name}.relativePath must be a relative POSIX path`);
      }
      const resolvedPath = path.resolve(realRoot, relativePath);
      if (!isWithinRoot(realRoot, resolvedPath)) {
        throw new Error(`${name}.relativePath escapes the model cache root`);
      }
      const realModelPath = await resolveRealPath(resolvedPath);
      if (!isWithinRoot(realRoot, realModelPath)) {
        throw new Error(`${name}.relativePath resolves outside the model cache root`);
      }
      const modelStat = await fileStat(realModelPath);
      if (!modelStat.isFile() && !modelStat.isDirectory()) {
        throw new Error(`${name}.relativePath must identify a regular file or directory`);
      }
      inventory.push(validateModelInventoryEntry({
        schemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
        modelId: localEntry.modelId,
        revision: localEntry.revision,
        adapterType: localEntry.adapterType,
      }, name));
    }
    return validateModelInventory(inventory);
  } catch (error) {
    if (!error.code) error.code = "model_cache_manifest_invalid";
    throw error;
  }
}

function parseManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("model cache manifest must contain valid JSON");
  }
  const manifest = requireObject(value, "model cache manifest");
  rejectUnknownFields(manifest, "model cache manifest", ["schemaVersion", "models"]);
  boundedInteger(manifest.schemaVersion, "model cache manifest.schemaVersion", {
    minimum: MODEL_INVENTORY_SCHEMA_VERSION,
    maximum: MODEL_INVENTORY_SCHEMA_VERSION,
  });
  if (!Array.isArray(manifest.models) || manifest.models.length > 64) {
    throw new Error("model cache manifest.models must contain at most 64 entries");
  }
  return manifest;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
