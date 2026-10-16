# DP3C3B2C2B2A — Durable scheduler hold (source-backed)

## Safety purpose
Existing B2C2B1 `gpu_resource_fences` table persists a separate physical reuse
safety state. A job or session lease becoming expired, interrupted, closed or
requeued is **not evidence** that a host process has stopped. This change makes
the scheduler consult committed non-`clear` fence rows before selecting a GPU.

## Scope
- `listBlockedGpuResources()` joins the SQLite/PostgreSQL persistence contract.
  It returns only `(workerId,gpuUuid)` for non-`clear` fences, sorted stably.
- `Scheduler.#runOnce()` checks these rows *inside the same scheduler transaction*
  and does so after normal lease recovery, before placement.
- `choosePlacement()` receives an exact `(workerId,gpuUuid)` set; an unrelated
  worker's device is not banned solely because its GPU UUID matches.
- Any fence-query failure rejects the scheduler transaction: no fallback to an
  empty set. An absent fence row has the same legacy placement semantics as B1.
- PostgreSQL uses `SELECT ... FOR UPDATE NOWAIT` for non-`clear` rows. It fails closed rather than waiting on locked rows; this blocks
  updates to those existing rows from concurrent ordinary SQL transactions
  until scheduling commits. SQLite uses its existing `BEGIN IMMEDIATE` transaction.
- No migration modifications. All 0001–0003 SQL hashes remain immutable.

## Critical limitations and remaining hazards
This is not complete concurrent broker/scheduler fencing. `FOR UPDATE NOWAIT` cannot
lock absent fence rows. A new uncoordinated insert could race with a scheduler
pass that observed no fence; other code may continue using existing allocator
paths. A mandatory shared lock protocol and atomic claim/lease transitions are
required in B2C2B2B before any managed execution capability can be advertised.

The new tests use *test-only direct SQL* to construct/clear fence fixtures.
**That is not a real authorized cleanup endpoint.** There is no durable
execution-attempt transition API or cryptographic/host attestation of cleanup.
State remains inert for new allocations unless a row already exists.

Existing pre-migration work might still be running and is **not automatically
quarantined**; the migration does not invent 'clear' records. A cautious
rollout to managed mode requires separate host reconciliation and operator opt-in.

## Acceptance requirements
1. Exact source guard: 57-path input, 64-path output, no accepted source drift.
2. New SQLite held/cleared/expiry/failure tests pass; root tests and SDK pass.
3. Disposable PG17 tests pass including scheduler placement and a concurrent
   independent writer blocked on a locked non-`clear` row; root tests 0 skips.
4. Final hashes unchanged after tests; test database removed.
5. No OCI, live GPU inference, privileged broker, commit, push or deployment.

## Next: B2C2B2B
Implement authenticated, transactionally bound managed allocation and attempt
reservation APIs. Fence-row creation must synchronize with the scheduler on
*previously absent rows*, and lease close/recovery/reassign must integrate with
host cleanup/quarantine. SQLite/PostgreSQL concurrency acceptance must prove
that no independent writer can bypass the same discipline.
