import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
  ValidationError,
} from "./validation.mjs";

export const MODEL_INVENTORY_SCHEMA_VERSION = 1;

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function validateModelInventoryEntry(value, name = "modelInventory") {
  const entry = requireObject(value, name);
  rejectUnknownFields(entry, name, [
    "schemaVersion",
    "modelId",
    "revision",
    "adapterType",
  ]);

  const schemaVersion = boundedInteger(entry.schemaVersion, `${name}.schemaVersion`, {
    minimum: MODEL_INVENTORY_SCHEMA_VERSION,
    maximum: MODEL_INVENTORY_SCHEMA_VERSION,
  });
  const modelId = requireIdentifier(
    entry.modelId,
    `${name}.modelId`,
    300,
    modelIdPattern,
  );
  const revision = requireIdentifier(
    entry.revision,
    `${name}.revision`,
    200,
    revisionPattern,
  );
  const adapterType = requireIdentifier(
    entry.adapterType,
    `${name}.adapterType`,
    100,
    modelIdPattern,
  );

  return Object.freeze({ schemaVersion, modelId, revision, adapterType });
}

export function validateModelInventory(value, name = "modelInventory") {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError(`${name} must be an array with at most 64 items`);
  }
  const modelIds = new Set();
  const inventory = value.map((item, index) => {
    const entry = validateModelInventoryEntry(item, `${name}[${index}]`);
    if (modelIds.has(entry.modelId)) {
      throw new ValidationError(`${name} contains duplicate modelId ${entry.modelId}`);
    }
    modelIds.add(entry.modelId);
    return entry;
  });
  return inventory.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function requireIdentifier(value, name, maximum, pattern) {
  const result = requireString(value, name, { maximum });
  if (!pattern.test(result)) {
    throw new ValidationError(`${name} contains unsupported characters`);
  }
  return result;
}
