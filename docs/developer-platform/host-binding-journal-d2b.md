# DP3C3B2C2D2B — Durable broker-measured host identity (test-only)

## Status and precise claim

This is a **non-executing, test-only** continuation of D1 (remote authority
observation) and D2A (operator-hinted Linux `/proc` inspection). The broker can
capture an *independently re-read* Linux process identity into its own SQLite
journal, anchored to an existing control-plane attempt/lease/worker/fence epoch.
This is **broker-measured evidence**, **not broker-origin workload execution** or
launch attestation. The process was identified by an operator-provided test hint;
the broker **did not create or own** it. No OCI runtime, GPU driver, host cleanup,
termination, or resource release is invoked.

## Operations

The new Unix socket operations accept exactly `{attemptId}` and require the
existing kernel SO_PEERCRED identity authorized for the configured broker worker.

- `capture-host-binding`: Requires the acknowledged local attempt and fence epoch,
  a restrictive operator hint matching the existing worker/lease/epoch, a
  **fresh** scoped control-plane observation reporting the **same held epoch**,
  and a matching current Linux boot ID, PID birth ticks, and cgroup-v2 placement.
  On success inserts an **immutable** local SQLite binding in a transaction.
  A duplicate attempt, already-bound PID birth identity, or uncertain observation
  is rejected. No caller-selected PID, GPU, epoch, executable or cgroup is allowed.
- `observe-bound-host`: Reads the frozen journal identity and rechecks procfs
  without consulting or modifying the operator hint. It returns `present`,
  `absent`, or `unknown`; `absent` means **only** that the specific PID birth is
  no longer present, not that the runtime, descendants or GPU are clean.
  If no binding exists, returns `unknown` and `no_durable_binding`.

All operation responses explicitly have `canLaunch:false`, `canRelease:false`,
`cleanupVerified:false`, `launchAttested:false` and `advisoryOnly:true`.
`observe-bound-host` also returns `authorityConfirmed:false` because a local
procfs observation does not establish the current remote hold.

## Journal and restart

`host_identity_bindings` in the existing owner-only singleton broker journal
stores attempt/lease/worker/fence epoch, boot ID, PID, start ticks, cgroup v2,
capture timestamp and fixed origin `operator-hint-procfs-test-only`. Two SQLite
triggers deny SQL UPDATE and DELETE. A duplicate PID birth across attempts is
rejected. Startup validates all previously persisted rows and their relationship
to `remote_claims`; disagreement fails closed before socket bind. An ordinary
broker restart does not clear bindings or quarantine holds.

These SQLite controls are **not tamper-proof cryptography** against an
administrator able to rewrite the journal or drop triggers. Runtime identity
attestation needs a future trusted broker-owned launch and an isolation-backed
runtime lifecycle, with complete containment and cleanup evidence.

## Non-goals and release invariants

- No launch, host process creation, host termination or OCI calls.
- No control-plane schema changes, fence release API, or changes to the normal
  scheduler's durable held-GPU exclusion.
- No claim of GPU ownership from `/proc`, container isolation, completeness of
  the process tree, or absence of GPU file descriptors.
- No automatic retry of pending or ambiguous remote claims.
- `absent` never means `clean`. Reboot mismatch yields `unknown`.

The following milestones must separately establish broker-controlled isolated
execution identity, trustworthy runtime inventory, device ownership, survivor
and descendant inspection, cleanup evidence, and atomic fence CAS release.

## Acceptance

Run on JPCMAIN from clean pushed D2A commit
`3ac59d86541f7c1072d4954680949394e9dca0ee` on the feature branch.
The guarded installer changes only five files: two existing files and three
new ones. Verify targeted and full root suites, SDK, and disposable PostgreSQL
against the expected hashes before accepting/committing. No auto-push.
