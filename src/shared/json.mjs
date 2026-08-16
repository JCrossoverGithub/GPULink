export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}
