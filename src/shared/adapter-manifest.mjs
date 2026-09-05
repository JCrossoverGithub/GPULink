import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
  ValidationError,
} from "./validation.mjs";

export const ADAPTER_MANIFEST_SCHEMA_VERSION = 1;
export const ADAPTER_EXECUTION_MODES = Object.freeze([
  "in-process",
  "bounded-process",
  "streaming-gateway",
]);

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function validateAdapterManifest(value, name = "adapterManifest") {
  const manifest = requireObject(value, name);
  rejectUnknownFields(manifest, name, [
    "schemaVersion",
    "type",
    "version",
    "executionMode",
  ]);

  const schemaVersion = boundedInteger(manifest.schemaVersion, `${name}.schemaVersion`, {
    minimum: ADAPTER_MANIFEST_SCHEMA_VERSION,
    maximum: ADAPTER_MANIFEST_SCHEMA_VERSION,
  });
  const type = requireString(manifest.type, `${name}.type`, { maximum: 100 });
  const version = requireString(manifest.version, `${name}.version`, { maximum: 100 });
  if (!semanticVersionPattern.test(version)) {
    throw new ValidationError(`${name}.version must be a semantic version`);
  }
  const executionMode = requireString(
    manifest.executionMode,
    `${name}.executionMode`,
    { maximum: 50 },
  );
  if (!ADAPTER_EXECUTION_MODES.includes(executionMode)) {
    throw new ValidationError(
      `${name}.executionMode must be one of ${ADAPTER_EXECUTION_MODES.join(", ")}`,
    );
  }

  return Object.freeze({ schemaVersion, type, version, executionMode });
}

export function validateAdapterManifests(value, name = "adapterManifests") {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError(`${name} must be an array with at most 64 items`);
  }
  const types = new Set();
  const manifests = value.map((item, index) => {
    const manifest = validateAdapterManifest(item, `${name}[${index}]`);
    if (types.has(manifest.type)) {
      throw new ValidationError(`${name} contains duplicate type ${manifest.type}`);
    }
    types.add(manifest.type);
    return manifest;
  });
  return manifests.sort((left, right) => left.type.localeCompare(right.type));
}
