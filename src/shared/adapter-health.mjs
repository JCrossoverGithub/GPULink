import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
  ValidationError,
} from "./validation.mjs";

export const ADAPTER_HEALTH_SCHEMA_VERSION = 1;
export const ADAPTER_HEALTH_SCHEMA_VERSION_V2 = 2;
export const ADAPTER_HEALTH_STATES = Object.freeze([
  "ready",
  "unavailable",
  "not-installed",
]);

const stateCodes = Object.freeze({
  ready: "ready",
  unavailable: "readiness_probe_failed",
  "not-installed": "adapter_not_installed",
});

const adapterIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function validateAdapterHealthReport(
  value,
  name = "adapterHealth",
) {
  const report = requireObject(value, name);

  const schemaVersion = boundedInteger(
    report.schemaVersion,
    `${name}.schemaVersion`,
    { minimum: 1, maximum: ADAPTER_HEALTH_SCHEMA_VERSION_V2 },
  );

  rejectUnknownFields(report, name, [
    "schemaVersion",
    "type",
    "state",
    "code",
    "checkedAt",
    ...(schemaVersion === 2 ? ["adapterId"] : []),
  ]);

  const type = requireString(report.type, `${name}.type`, {
    maximum: 100,
  });

  const state = requireString(report.state, `${name}.state`, {
    maximum: 50,
  });

  if (!ADAPTER_HEALTH_STATES.includes(state)) {
    throw new ValidationError(
      `${name}.state must be one of ${ADAPTER_HEALTH_STATES.join(", ")}`,
    );
  }

  const code = requireString(report.code, `${name}.code`, {
    maximum: 100,
  });

  if (code !== stateCodes[state]) {
    throw new ValidationError(
      `${name}.code must be ${stateCodes[state]} for state ${state}`,
    );
  }

  const checkedAt = boundedInteger(
    report.checkedAt,
    `${name}.checkedAt`,
  );

  if (schemaVersion === 1) {
    return Object.freeze({
      schemaVersion,
      type,
      state,
      code,
      checkedAt,
    });
  }

  const adapterId = requireString(
    report.adapterId,
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
    state,
    code,
    checkedAt,
  });
}

export function validateAdapterHealth(value, name = "adapterHealth") {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError(
      `${name} must be an array with at most 64 items`,
    );
  }

  const v1Types = new Set();
  const v2Types = new Set();
  const adapterIds = new Set();

  const reports = value.map((item, index) => {
    const report = validateAdapterHealthReport(
      item,
      `${name}[${index}]`,
    );

    if (report.schemaVersion === 1) {
      if (v1Types.has(report.type)) {
        throw new ValidationError(
          `${name} contains duplicate type ${report.type}`,
        );
      }
      v1Types.add(report.type);
    } else {
      if (adapterIds.has(report.adapterId)) {
        throw new ValidationError(
          `${name} contains duplicate adapterId ${report.adapterId}`,
        );
      }
      adapterIds.add(report.adapterId);
      v2Types.add(report.type);
    }

    return report;
  });

  for (const type of v1Types) {
    if (v2Types.has(type)) {
      throw new ValidationError(
        `${name} cannot mix v1 and v2 for type ${type}`,
      );
    }
  }

  return reports.sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      (left.adapterId ?? "").localeCompare(right.adapterId ?? ""),
  );
}

export function adapterHealthReport(type, state, checkedAt) {
  return validateAdapterHealthReport({
    schemaVersion: ADAPTER_HEALTH_SCHEMA_VERSION,
    type,
    state,
    code: stateCodes[state],
    checkedAt,
  });
}
