// Cooperative local stop deadline. The control plane's durable hold remains
// authoritative when this process is partitioned, stalled or dead.
// Use server-relative duration less round trip, not synchronized wall clocks.
export function jobLeaseRemainingMs(response, expected, roundTripMs) {
  const j = response?.job;
  if (!j || j.id !== expected.jobId || j.leaseId !== expected.leaseId ||
      j.assignedWorkerId !== expected.workerId || j.status !== 'running' ||
      !Number.isSafeInteger(j.updatedAt) || !Number.isSafeInteger(j.leaseExpiresAt) ||
      !Number.isFinite(roundTripMs) || roundTripMs < 0) return 0;
  return Math.max(0, Math.min(2_147_483_647,
    Math.floor(j.leaseExpiresAt - j.updatedAt - roundTripMs)));
}

export function createJobLeaseGuard(controller, expected, {
  clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let timer;
  let deadline = -Infinity;
  let closed = false;
  function check() {
    if (closed || controller.signal.aborted) return false;
    if (clock() >= deadline) {
      controller.abort(new Error('job local lease deadline reached'));
      return false;
    }
    return true;
  }
  function onDeadline() {
    if (check()) timer = schedule(onDeadline, Math.max(1, Math.ceil(deadline-clock())));
  }
  return {
    arm(response, requestedAt) {
      // Never revive an already expired or aborted authority on a late renew.
      if (closed || controller.signal.aborted || (timer !== undefined && !check())) return 0;
      const now = clock();
      const remaining = jobLeaseRemainingMs(response, expected, now-requestedAt);
      if (remaining <= 0) { controller.abort(new Error('invalid or expired job lease acknowledgment')); return 0; }
      if (timer !== undefined) cancel(timer);
      deadline = now + remaining;
      timer = schedule(onDeadline, remaining);
      return remaining;
    },
    check,
    close() { closed = true; if (timer !== undefined) cancel(timer); },
  };
}
