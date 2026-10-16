# DP3C3B2A — Acceptance and verification plan

**Scope:** A dry-run broker-intent and policy-evaluation extension to B1. **No real broker or isolation claim.**

## A. Baseline and source-integrity preflight

- Confirm the exact DP3C3B1 accepted branch and Git HEAD.
- Confirm expected 38-path porcelain status (the original 33 plus B1's five).
- Compare all 123 original selected source hashes from the exact-source manifest and all five B1 payload hashes.
- Reject symlinks in paths and unexpected existing targets; validate the four new B2A package hashes.
- Apply only four new files, with exclusive creation. Roll back only files created by that invocation on failure. Expected state: 42 paths. No `git reset`, `git clean`, `git commit`, installs or deployments.

## B. Broker-intent test cases (new)

- Correct `schemaVersion`, strictly recognized fields and immutable normalized intent.
- Reject commands, env secrets, engine sockets, raw GPU IDs, mutable image tags, privileged launch settings, arbitrary mount paths.
- Reject unknown fields, getters, invalid digests/versions, path-like IDs, integer overflow, unsupported IPC.
- Bind request to broker-side worker identity, current lease, lease generation, status and expiry.
- Bind reservation ID, attempt ID and lease ID to a held, unexpired GPU reservation; GPU IDs come only from broker records.
- Require no prior attempt before admission; reject all recorded attempt states. Note: this alone does **not** supply atomicity.
- Require approved artifact tuple, pinned image digest and operator profile binding; reject reviewed/untrusted classes in B2A.
- Require all six proposed isolation controls present in the declared approved policy **and** the test runtime evidence. This is a schema check, not host attestation.
- Reject expired/revoked lease, unrecognized caller, duplicate devices, unapproved runtime, unsupported IPC, missing isolation, incomplete security profiles.
- Never yield a credential, a runtime handle, `canLaunch:true`, or a socket/engine command; never start a process.

## C. JPCMAIN verification

1. Run `scripts/01_apply_dp3c3b2a.sh` against the accepted 38-path checkout.
2. Run `scripts/02_test_dp3c3b2a.sh`. Must complete:
   - New B2A admission conformance tests, 0 failures.
   - Existing B1 29-test conformance unchanged.
   - Existing DP3C3A IPC/supervisor/approved-subprocess regression tests unchanged.
   - `npm run check` (root suite), report PostgreSQL skips separately; newly added B2A tests participate automatically under `node --test`.
   - `npm --prefix packages/gpulink-sdk run build`, `npm --prefix packages/gpulink-sdk run test`.
   - Final 42-path Git status plus original 123 hashes, B1 five, B2A four.
3. Failure of any required command blocks B2A acceptance. Prior accepted B1 remains baseline; do not mask failures with reset.

## D. Not satisfied by B2A (must not advertise)

- Broker authentication from OS/kernel or mTLS, protected socket and durable permission model.
- Protected broker-owned ledger, atomic compare-and-swap and restart-safe idempotence.
- Effective OCI/VM kernel isolation, hostile workload security, network deny, host file denial.
- Actual GPU exclusivity, CDI binding, driver hardware isolation, performance or real-model inference.
- Correct teardown of all descendants and resource quotas under worker or broker crashes.
- Real worker integration, trusted-completion ACK preservation through broker-driven sessions.
- Cross-node lease federation and accurate final placement, Postgres integrations currently skipped.

**Exit criterion:** accepted, isolated **design/conformance foundation**, not a secure workload launcher. Additional implementation must be security-reviewed before any executable OCI control path is wired into a production worker.
