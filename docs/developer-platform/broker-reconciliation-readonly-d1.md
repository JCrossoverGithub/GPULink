# DP3C3B2C2D1: Broker read-only attempt reconciliation

## Scope and boundary

This candidate adds **diagnostic observation only** for an already-journaled
broker attempt. It does **not** add runtime inspection, cleanup evidence,
fence release, lease revival, GPU execution, or a new allocation authority.
The existing Linux broker remains `--test-only`, and the control-plane route
is absent unless the operator has configured a broker principal.

Local IPC: `observe-authoritative` with `{attemptId}`. The broker obtains
the Linux peer UID via `SO_PEERCRED`, checks the caller's worker scope,
retrieves the attempt's immutable subject/lease identity from its local
`remote_claims` journal, and uses a private operator credential to query
`POST /v1/broker/attempts/observe`. The unprivileged caller cannot override
the worker, lease, GPU, project, attempt epoch, or approval.

The control plane authenticates the broker's **dedicated**, worker/project-scoped
credential. Its single-statement read joins `execution_attempts` with
`gpu_resource_fences`, and only searches the exact attempt, subject, lease,
worker, and project. Missing or cross-tenant attempts appear as `not_found`.
A row with the same held GPU fence/epoch/attempt/lease/subject is `held`;
any unmatched or cleared fence is `unconfirmed`. The database **is not
modified** during observation.

All outcomes contain `canLaunch:false`, `canRelease:false`,
`evidenceVerified:false`. **None** asserts that a host is clean.
A `not_found` observation does **not** prove no process is running.
The broker never rewrites its local journal from this read, including
after process restart or after a mismatched observation. A known local epoch
mismatch or a network failure returns `broker_authority_uncertain`.

## Trust and threat limitations

- This is not cross-host attestation: the broker identity is still a
  locally kernel-authenticated test broker with an operator-managed
  control-plane bearer token.
- Database read consistency is a single SQL statement on each backend.
  It cannot prove the runtime/container/process state on the host.
- No cleanup-proof verifier or physical containment mechanism exists yet.
  Never automate resource release or use this response as scheduling
  eligibility.
- No production deployment, real GPU runtime, keys, private certificates,
  credentials or user-specific configuration are included.

## Required acceptance

1. Exact 78-path accepted checkpoint and guarded transition to 81 paths.
2. Read-only local end-to-end tests, including restart, unknown attempt,
   worker/project isolation, malformed input, and no release permission.
3. Existing broker, claim, scheduler, and SQLite regression tests.
4. Disposable PostgreSQL test with
   `GPULINK_TEST_POSTGRES_URL` and
   `GPULINK_D1_TEST_DB_ACK=YES_DISPOSABLE`, including mismatched fence
   linkage and missing/cross-scope attempts.
5. Full repository and Client SDK gates with Postgres enabled, source
   revalidation, and temporary database removal.

## Future milestones

D2 should specify host observation provenance and how process/runtime
identity is pinned across restarts. D3 should define independently validated
cleanup proof; D4 should add compare-and-swap transactional release with
fresh epoch checks and crash/race tests. Do not implement either release
or OCI launch in D1.
