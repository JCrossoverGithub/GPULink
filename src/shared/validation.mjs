export function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value;
}

export function optionalObject(value, name, fallback = {}) {
  if (value === undefined) return fallback;
  return requireObject(value, name);
}

export function requireString(value, name, { maximum = 200 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new ValidationError(`${name} must contain at most ${maximum} characters`);
  }
  return result;
}

export function optionalString(value, name, fallback = null, options = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  return requireString(value, name, options);
}

export function boundedInteger(value, name, {
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  fallback,
} = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function stringArray(value, name, { maximumItems = 64 } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ValidationError(`${name} must be an array with at most ${maximumItems} items`);
  }
  return [...new Set(value.map((item, index) =>
    requireString(item, `${name}[${index}]`, { maximum: 100 })))]
    .sort();
}

export function rejectUnknownFields(object, name, allowedFields) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(object).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new ValidationError(`${name} contains unexpected field ${unknown.sort()[0]}`);
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}
