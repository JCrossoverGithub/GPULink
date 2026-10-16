# DP3C3B2C2B2B — Atomic internal execution-attempt claims (candidate)

**No workload-launch permission, no privileged broker route, no host cleanup certification.**

## Authority and locking

`reservePersistedExecutionAttempt(persistence, input)` is an **internal, non-networked,
non-executing** transaction-only primitive. It is not a broker-authenticated API and it
cannot be used to approve an image, adapter, isolation backend or launch. No `canLaunch:true`
path exists. The input is caller-supplied for this test-oriented stage (including `now`);
future broker integration MUST inject trusted server time and independently authenticated
host identity, workload digest/approval, and isolation verification.

SQLite takes `BEGIN IMMEDIATE` using existing `SqlitePersistence.transaction` for the
whole precondition check, missing-row INSERT/clear-row CAS and execution attempt INSERT.
PostgreSQL joins the **exact scheduler transaction-scoped advisory lock** with
`pg_try_advisory_xact_lock(0x4750554c,0x494e4b31)` **before reading or creating** a
fence. It locks the assigned worker and job/session rows `FOR UPDATE`, verifies exact
worker + GPU inventory + unexpired lease, rejects other occupying workloads on that
worker/device, inserts the first `reserved` fence or CASes a genuinely `clear` one,
and inserts the immutable attempt tombstone in the same transaction. Any failure rolls
back both writes. Contention fails closed; the writer cannot speculate about a missing
fence row. All claim writers MUST use this protocol; out-of-band SQL bypass is not trusted.

The requested actor must already be centrally scheduled. A claim **cannot** independently
allocate hardware. The source of truth for placement remains jobs/sessions leases. A
claim records an exclusive *host safety hold* that the scheduler already honors. Fresh
claims under a held row (including replay with the same attempt ID) are denied.

## Limitations and next gate

- The new method deliberately exists only on the persistence **transaction view**;
  there is no public API/worker client method or authenticated broker request.
- The low-level SQLite `ControlPlaneDatabase` writer is an internal building block;
  its callers must always use the outer `SqlitePersistence.transaction`.
- Host process lifecycle and cleanup attestation are NOT implemented. A resource
  intentionally remains held after lease expiry, close, job recovery, or restart.
- Neither `reserved` nor presence of an approved-looking digest is a launch grant.
- Legacy workloads may have no fence; initial managed rollout requires host
  reconciliation and explicit operator opt-in. No automatic clean backfill.
- The schema still permits direct test-fixture SQL to clear a fence; such SQL is
  NOT an authorized production cleanup API.
- No database migration changes; previous 0001/0002/0003 hashes are immutable.
- Full acceptance requires clean SQLite and disposable PostgreSQL tests, including
  independent instance concurrency and zero PostgreSQL skips, followed by SDK tests
  and exact source hash checks.

**Next:** add authenticated broker claim delivery, server-controlled time/approval,
end-to-end host cleanup/reconciliation and controlled release under this same fence
protocol, plus opt-in managed mode enrollment. Untrusted OCI launch remains disabled.
