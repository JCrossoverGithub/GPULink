import {
  boundedInteger,
  rejectUnknownFields,
  requireObject,
  ValidationError,
} from "./validation.mjs";

export const BENCHMARK_TYPE = "benchmark.gpu";
export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_MATRIX_SIZES = Object.freeze([1024, 2048, 4096, 8192]);
export const BENCHMARK_DEFAULTS = Object.freeze({
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  matrixSize: 4096,
  warmupIterations: 3,
  measuredIterations: 10,
});

export function validateWorkloadPayload(type, payload) {
  if (type === BENCHMARK_TYPE) return validateBenchmarkPayload(payload);
  return payload;
}

export function validateBenchmarkPayload(value) {
  const payload = requireObject(value, "payload");
  rejectUnknownFields(payload, "payload", [
    "schemaVersion",
    "matrixSize",
    "warmupIterations",
    "measuredIterations",
  ]);

  const schemaVersion = boundedInteger(payload.schemaVersion, "payload.schemaVersion", {
    minimum: BENCHMARK_SCHEMA_VERSION,
    maximum: BENCHMARK_SCHEMA_VERSION,
    fallback: BENCHMARK_DEFAULTS.schemaVersion,
  });
  const matrixSize = boundedInteger(payload.matrixSize, "payload.matrixSize", {
    minimum: BENCHMARK_MATRIX_SIZES[0],
    maximum: BENCHMARK_MATRIX_SIZES.at(-1),
    fallback: BENCHMARK_DEFAULTS.matrixSize,
  });
  if (!BENCHMARK_MATRIX_SIZES.includes(matrixSize)) {
    throw new ValidationError(
      `payload.matrixSize must be one of ${BENCHMARK_MATRIX_SIZES.join(", ")}`,
    );
  }

  return {
    schemaVersion,
    matrixSize,
    warmupIterations: boundedInteger(
      payload.warmupIterations,
      "payload.warmupIterations",
      { minimum: 1, maximum: 10, fallback: BENCHMARK_DEFAULTS.warmupIterations },
    ),
    measuredIterations: boundedInteger(
      payload.measuredIterations,
      "payload.measuredIterations",
      { minimum: 1, maximum: 25, fallback: BENCHMARK_DEFAULTS.measuredIterations },
    ),
  };
}
