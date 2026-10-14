import {
  boundedInteger,
  optionalObject,
  optionalString,
  rejectUnknownFields,
  requireObject,
  requireString,
  stringArray,
  ValidationError,
} from "./validation.mjs";

export const SESSION_SCHEMA_VERSION = 1;

export const SESSION_LIFECYCLE_STATES = Object.freeze([
  "requested",
  "allocated",
  "connecting",
  "active",
  "interrupted",
  "closed",
]);

export const SESSION_MAX_METADATA_BYTES = 8_192;
export const SESSION_MAX_INTERRUPTIONS = 3;

export function validateSessionRequest(value) {
  const session = requireObject(
    value,
    "session",
  );

  rejectUnknownFields(
    session,
    "session",
    [
      "schemaVersion",
      "projectId",
      "capability",
      "priority",
      "requirements",
      "metadata",
      "recovery",
    ],
  );

  const schemaVersion =
    boundedInteger(
      session.schemaVersion,
      "session.schemaVersion",
      {
        minimum: SESSION_SCHEMA_VERSION,
        maximum: SESSION_SCHEMA_VERSION,
        fallback: SESSION_SCHEMA_VERSION,
      },
    );

  const projectId =
    requireString(
      session.projectId,
      "session.projectId",
      { maximum: 100 },
    );

  const capability =
    requireString(
      session.capability,
      "session.capability",
      { maximum: 100 },
    );

  const priority =
    boundedInteger(
      session.priority,
      "session.priority",
      {
        minimum: -1_000,
        maximum: 1_000,
        fallback: 0,
      },
    );

  const requirements =
    validateRequirements(
      optionalObject(
        session.requirements,
        "session.requirements",
      ),
      capability,
    );

  const metadata =
    validateMetadata(
      optionalObject(
        session.metadata,
        "session.metadata",
      ),
    );

  const recovery =
    validateRecovery(
      optionalObject(
        session.recovery,
        "session.recovery",
      ),
    );

  return {
    schemaVersion,
    projectId,
    capability,
    priority,
    requirements,
    metadata,
    recovery,
  };
}

function validateRequirements(
  value,
  capability,
) {
  rejectUnknownFields(
    value,
    "session.requirements",
    [
      "gpuCount",
      "minVramMiB",
      "capabilities",
      "model",
      "adapter",
    ],
  );

  const gpuCount =
    boundedInteger(
      value.gpuCount,
      "session.requirements.gpuCount",
      {
        minimum: 1,
        maximum: 1,
        fallback: 1,
      },
    );

  const minVramMiB =
    boundedInteger(
      value.minVramMiB,
      "session.requirements.minVramMiB",
      {
        minimum: 0,
        maximum: 1_048_576,
        fallback: 0,
      },
    );

  const capabilities =
    value.capabilities === undefined
      ? [capability]
      : stringArray(
          value.capabilities,
          "session.requirements.capabilities",
          { maximumItems: 32 },
        );

  if (!capabilities.includes(capability)) {
    throw new ValidationError(
      "session.requirements.capabilities must include session.capability",
    );
  }

  const model =
    optionalString(
      value.model,
      "session.requirements.model",
      null,
      { maximum: 300 },
    );

  const adapter =
    optionalString(
      value.adapter,
      "session.requirements.adapter",
      null,
      { maximum: 200 },
    );

  return {
    gpuCount,
    minVramMiB,
    capabilities,
    model,
    adapter,
  };
}

function validateRecovery(value) {
  rejectUnknownFields(
    value,
    "session.recovery",
    [
      "maxInterruptions",
    ],
  );

  return {
    maxInterruptions:
      boundedInteger(
        value.maxInterruptions,
        "session.recovery.maxInterruptions",
        {
          minimum: 0,
          maximum: SESSION_MAX_INTERRUPTIONS,
          fallback: 0,
        },
      ),
  };
}

function validateMetadata(value) {
  const normalized =
    normalizeMetadataValue(
      value,
      "session.metadata",
      0,
    );

  const encoded =
    JSON.stringify(normalized);

  if (
    Buffer.byteLength(
      encoded,
      "utf8",
    ) > SESSION_MAX_METADATA_BYTES
  ) {
    throw new ValidationError(
      `session.metadata must encode to at most ${SESSION_MAX_METADATA_BYTES} bytes`,
    );
  }

  return normalized;
}

function normalizeMetadataValue(
  value,
  name,
  depth,
) {
  if (depth > 4) {
    throw new ValidationError(
      `${name} exceeds maximum nesting depth`,
    );
  }

  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length > 1_000) {
      throw new ValidationError(
        `${name} strings must contain at most 1000 characters`,
      );
    }

    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(
        `${name} numbers must be finite`,
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw new ValidationError(
        `${name} arrays must contain at most 64 items`,
      );
    }

    return value.map(
      (item, index) =>
        normalizeMetadataValue(
          item,
          `${name}[${index}]`,
          depth + 1,
        ),
    );
  }

  if (
    typeof value !== "object" ||
    value === undefined
  ) {
    throw new ValidationError(
      `${name} must contain only JSON-compatible values`,
    );
  }

  const prototype =
    Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new ValidationError(
      `${name} must contain only plain JSON objects`,
    );
  }

  const entries =
    Object.entries(value);

  if (entries.length > 64) {
    throw new ValidationError(
      `${name} objects must contain at most 64 fields`,
    );
  }

  const normalizedEntries =
    entries
      .map(([key, item]) => {
        const normalizedKey =
          requireString(
            key,
            `${name} key`,
            { maximum: 100 },
          );

        return [
          normalizedKey,
          normalizeMetadataValue(
            item,
            `${name}.${normalizedKey}`,
            depth + 1,
          ),
        ];
      })
      .sort(
        ([left], [right]) =>
          left.localeCompare(right),
      );

  return Object.fromEntries(
    normalizedEntries,
  );
}
