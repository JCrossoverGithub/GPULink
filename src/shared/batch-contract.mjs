import { requireObject, ValidationError } from './validation.mjs';

// Reserved capability namespace: old workers and streaming adapters cannot
// satisfy a durable external job by advertising a bare capability string.
export const BATCH_PREFIX = 'external.batch.';
export const BATCH_JSON_LIMIT = 32 * 1024;
export const isBatchType = type => typeof type === 'string' && type.startsWith(BATCH_PREFIX);
export function validBatchType(type) {
  return isBatchType(type) && /^external\.batch\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(type) && type.length <= 100;
}

export function batchJson(value, name = 'batch JSON') {
  requireObject(value, name);
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('nonfinite');
      return v;
    });
  } catch { throw new ValidationError(`${name} must be finite JSON`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > BATCH_JSON_LIMIT) {
    throw new ValidationError(`${name} exceeds ${BATCH_JSON_LIMIT} UTF-8 bytes`);
  }
  return encoded;
}
