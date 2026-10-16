/**
 * DP3C3B1 deterministic in-memory conformance backend.
 * Never creates a process or opens a network/socket/GPU device.
 * Cannot certify isolation and cannot produce a GPULink completion ACK.
 */
import {
  assertRuntimeAdmission, validateRuntimeReport, WorkloadRuntimeError,
} from './workload-runtime-contract.mjs';

export function createFakeWorkloadRuntime({report, failPrepare = false, failStart = false} = {}) {
  const r = validateRuntimeReport(report);
  if (r.verification !== 'simulated') throw new WorkloadRuntimeError('fake_must_be_simulated');
  const prepared = new WeakMap();
  const seen = new Set();
  const attempts = new Map();
  const snapshots = () => [...attempts.values()].map(a => Object.freeze({
    attemptId:a.attemptId, leaseId:a.leaseId, state:a.state, cleaned:a.cleaned,
  })).sort((a,b)=>a.attemptId.localeCompare(b.attemptId));

  async function prepare(admission) {
    assertRuntimeAdmission(admission, r.runtimeId);
    if (r.availability !== 'available') throw new WorkloadRuntimeError('runtime_unavailable');
    if (seen.has(admission.attemptId)) throw new WorkloadRuntimeError('duplicate_attempt');
    seen.add(admission.attemptId);
    if (failPrepare) throw new WorkloadRuntimeError('fake_prepare_failed');
    const state = {
      attemptId: admission.attemptId, leaseId: admission.leaseId,
      state:'prepared', cleaned:false, done:false, exit:null, finish:null,
    };
    state.exitPromise = new Promise(resolve => { state.finish = resolve; });
    attempts.set(state.attemptId, state);
    const token = Object.freeze({
      async dispose() {
        if (state.cleaned) return;
        if (!state.done) {
          state.done = true;
          state.exit = Object.freeze({exitCode:null,signal:state.state === 'prepared' ? 'PREPARED_DISPOSED' : 'TERMINATED'});
          state.finish(state.exit);
        }
        state.state = 'disposed'; state.cleaned = true;
      },
    });
    prepared.set(token, state);
    return token;
  }

  async function start(token) {
    const state = prepared.get(token);
    if (!state || state.state !== 'prepared' || state.cleaned) {
      throw new WorkloadRuntimeError('invalid_prepared_workload');
    }
    state.state = 'starting';
    if (failStart) {
      await token.dispose();
      throw new WorkloadRuntimeError('fake_start_failed');
    }
    state.state = 'running';
    return Object.freeze({
      attemptId:state.attemptId,
      waitForExit() { return state.exitPromise; },
      async terminate() {
        if (state.done) return;
        state.done = true;
        state.state = 'terminated';
        state.exit = Object.freeze({exitCode:null, signal:'TERMINATED'});
        state.finish(state.exit);
      },
      async dispose() {
        if (state.cleaned) return;
        if (!state.done) {
          state.done = true;
          state.exit = Object.freeze({exitCode:null, signal:'TERMINATED'});
          state.finish(state.exit);
        }
        state.state = 'disposed'; state.cleaned = true;
      },
    });
  }

  async function reconcile(activeAttemptIds) {
    if (!(activeAttemptIds instanceof Set) ||
        [...activeAttemptIds].some(id=>typeof id !== 'string')) {
      throw new WorkloadRuntimeError('invalid_active_attempts');
    }
    for (const state of attempts.values()) {
      if (activeAttemptIds.has(state.attemptId) || state.cleaned) continue;
      if (!state.done) {
        state.done = true;
        state.exit = Object.freeze({exitCode:null, signal:'RECONCILED'});
        state.finish(state.exit);
      }
      state.state = 'disposed'; state.cleaned = true;
    }
  }

  const runtime = Object.freeze({
    inspect: async () => r,
    prepare,
    start,
    reconcile,
  });
  const controller = Object.freeze({
    /** Simulate *process exit only*, not IPC END or worker acknowledgment. */
    exit(attemptId, exitCode = 0) {
      const state = attempts.get(attemptId);
      if (!state || state.state !== 'running' || state.done ||
          !Number.isSafeInteger(exitCode)) throw new WorkloadRuntimeError('invalid_fake_exit');
      state.done = true; state.state = 'exited';
      state.exit = Object.freeze({exitCode, signal:null});
      state.finish(state.exit);
    },
    snapshots,
  });
  return Object.freeze({runtime, controller});
}
