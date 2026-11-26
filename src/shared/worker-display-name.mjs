// Opt-in public operator label, never registration or authorization identity.
export const WORKER_DISPLAY_LABEL = 'gpulink.display-name';
export function validWorkerDisplayName(value) {
  return typeof value === 'string' && value.length <= 40 && value.trim() === value && /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9 ._-]{0,38}[A-Za-z0-9])$/u.test(value);
}
