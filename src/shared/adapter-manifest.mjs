import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
  ValidationError,
} from "./validation.mjs";

export const ADAPTER_MANIFEST_SCHEMA_VERSION = 1;
export const ADAPTER_MANIFEST_SCHEMA_VERSION_V2 = 2;
export const ADAPTER_EXECUTION_MODES = Object.freeze([
  "in-process",
  "bounded-process",
  "streaming-gateway",
]);

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const adapterIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function validateAdapterManifest(value, name = "adapterManifest") {
  const manifest = requireObject(value, name);

  const schemaVersion = boundedInteger(
    manifest.schemaVersion,
    `${name}.schemaVersion`,
    { minimum: 1, maximum: ADAPTER_MANIFEST_SCHEMA_VERSION_V2 },
  );

  rejectUnknownFields(manifest, name, [
    "schemaVersion",
    "type",
    "version",
    "executionMode",
    ...(schemaVersion === 2 ? ["adapterId"] : []),
  ]);

  const type = requireString(manifest.type, `${name}.type`, {
    maximum: 100,
  });

  const version = requireString(manifest.version, `${name}.version`, {
    maximum: 100,
  });

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

  if (schemaVersion === 1) {
    return Object.freeze({
      schemaVersion,
      type,
      version,
      executionMode,
    });
  }

  const adapterId = requireString(
    manifest.adapterId,
    `${name}.adapterId`,
    { maximum: 200 },
  );

  if (!adapterIdPattern.test(adapterId)) {
    throw new ValidationError(
      `${name}.adapterId contains unsupported characters`,
    );
  }

  return Object.freeze({
    schemaVersion,
    type,
    adapterId,
    version,
    executionMode,
  });
}

export function validateAdapterManifests(value, name = "adapterManifests") {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError(
      `${name} must be an array with at most 64 items`,
    );
  }

  const v1Types = new Set();
  const v2Types = new Set();
  const adapterIds = new Set();

  const manifests = value.map((item, index) => {
    const manifest = validateAdapterManifest(
      item,
      `${name}[${index}]`,
    );

    if (manifest.schemaVersion === 1) {
      if (v1Types.has(manifest.type)) {
        throw new ValidationError(
          `${name} contains duplicate type ${manifest.type}`,
        );
      }
      v1Types.add(manifest.type);
    } else {
      if (adapterIds.has(manifest.adapterId)) {
        throw new ValidationError(
          `${name} contains duplicate adapterId ${manifest.adapterId}`,
        );
      }
      adapterIds.add(manifest.adapterId);
      v2Types.add(manifest.type);
    }

    return manifest;
  });

  for (const type of v1Types) {
    if (v2Types.has(type)) {
      throw new ValidationError(
        `${name} cannot mix v1 and v2 for type ${type}`,
      );
    }
  }

  return manifests.sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      (left.adapterId ?? "").localeCompare(right.adapterId ?? ""),
  );
}
