import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  requireString,
  ValidationError,
} from "./validation.mjs";

export const ADAPTER_HEALTH_SCHEMA_VERSION = 1;
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

export function validateAdapterHealthReport(value, name = "adapterHealth") {
  const report = requireObject(value, name);
  rejectUnknownFields(report, name, [
    "schemaVersion",
    "type",
    "state",
    "code",
    "checkedAt",
  ]);

  const schemaVersion = boundedInteger(report.schemaVersion, `${name}.schemaVersion`, {
    minimum: ADAPTER_HEALTH_SCHEMA_VERSION,
    maximum: ADAPTER_HEALTH_SCHEMA_VERSION,
  });
  const type = requireString(report.type, `${name}.type`, { maximum: 100 });
  const state = requireString(report.state, `${name}.state`, { maximum: 50 });
  if (!ADAPTER_HEALTH_STATES.includes(state)) {
    throw new ValidationError(
      `${name}.state must be one of ${ADAPTER_HEALTH_STATES.join(", ")}`,
    );
  }
  const code = requireString(report.code, `${name}.code`, { maximum: 100 });
  if (code !== stateCodes[state]) {
    throw new ValidationError(`${name}.code must be ${stateCodes[state]} for state ${state}`);
  }
  const checkedAt = boundedInteger(report.checkedAt, `${name}.checkedAt`);

  return Object.freeze({ schemaVersion, type, state, code, checkedAt });
}

export function validateAdapterHealth(value, name = "adapterHealth") {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError(`${name} must be an array with at most 64 items`);
  }
  const types = new Set();
  const reports = value.map((item, index) => {
    const report = validateAdapterHealthReport(item, `${name}[${index}]`);
    if (types.has(report.type)) {
      throw new ValidationError(`${name} contains duplicate type ${report.type}`);
    }
    types.add(report.type);
    return report;
  });
  return reports.sort((left, right) => left.type.localeCompare(right.type));
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
