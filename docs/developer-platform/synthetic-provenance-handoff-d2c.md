# DP3C3B2C2D2C — Broker-origin synthetic provenance handoff (test-only)

## Precisely what this establishes

D2C adds a **test-only** demonstration of an ordered, crash-conservative
broker-to-host provenance handoff. The Linux broker can create exactly one
**fixed GPU-free Python sleep helper** for an explicitly claimed and fenced
execution attempt, measure the helper's own kernel process identity, and record
that identity in the pre-existing owner-only single-writer SQLite journal.

This demonstrates that the *test fixture* was spawned by the broker, rather than
selected from an operator-provided PID hint. **It does not establish trusted
workload launch, OCI isolation, complete process-tree ownership, GPU device
ownership, containment, cleanup, or permission to release a control-plane
resource fence.** The helper is not a user workload, is not a hardened sandbox,
never accesses GPU devices, and exits by itself after a bounded 12-second sleep.

## Opt-in and request contract

- The broker already requires `--test-only` on Linux. D2C additionally requires
  `--synthetic-provenance-probe`, together with `--authority-config`. Without this
  explicit separate flag, the two D2C operations are unavailable.
- `spawn-synthetic-probe` and `observe-synthetic-probe` accept exactly
  `{attemptId}` over the existing owner-only local Unix socket. The kernel
  `SO_PEERCRED` principal must match the broker's configured worker.
- No peer can submit a PID, executable, image, GPU, device, environment,
  arguments, namespace, cgroup, or resource-limit request. The program to
  execute is a single hard-coded, non-interactive Python helper using a clean
  environment, closed inherited descriptors, no shell and no network I/O.
- `spawn-synthetic-probe` requires an exact locally acknowledged reservation,
  a positive held fence epoch, a fresh scoped control-plane `held` observation
  of that same epoch, and no operator-hinted durable binding or previous intent.
- All responses retain `canLaunch:false`, `canRelease:false`,
  `workloadLaunchAttested:false`, `cleanupVerified:false` and `advisoryOnly:true`.
  `canLaunch` means **no authorization to launch an actual workload**, not that
  the explicitly named synthetic fixture operation does nothing.

## Durable crash handoff

The new `synthetic_probe_events` table is append-only with reject-UPDATE and
reject-DELETE triggers. It stores event 1 `intent_durable`, followed by event 2
`synthetic_child_observed`. Each event binds the same attempt, worker, lease and
fence epoch. Event 2 also records measured boot ID, PID birth ticks and cgroup-v2
placement; no process details are accepted from a remote caller. Source bytes,
old PostgreSQL migrations and normal scheduling are unchanged.

**Ordering:** a SQLite `BEGIN IMMEDIATE` transaction commits event 1 **before**
subprocess creation; only after a stable `/proc` observation and recheck of the
local claim does another transaction commit event 2. A crash or error anywhere
between these points leaves an intent with unknown birth, without automatic
retry or release. Broker restart quarantines old claims as it did in D1/D2B.
A recorded PID becoming absent means only that the *specific birth* is no
longer visible; it does not imply cleanup or a reusable GPU.

Startup validates journal structure and the existing matching reservation.
Corruption blocks socket startup instead of silently dropping the record.
Ordinary SQLite triggers are not cryptographic protection against a privileged
host administrator with direct database access.

## Non-goals / next separate gates

This small proof uses a **test-only non-isolated child** to verify durable
prelaunch ordering. There is no OCI/container runtime integration, no durable
host-runtime supervision across a broker crash, no descendant inventory, no
complete cleanup evidence, no atomic control-plane fence compare-and-swap
release API, and no automatic reconciliation after restart. An actual
GPU/OCI workload would require a distinct operator-approved immutable runtime
artifact, isolation proof, broker-owned runtime handle and lifecycle, attested
host inventory and termination, and a separately authorized fence-release gate.

The test helper may outlive a broker crash for up to its bounded sleep duration.
This is safe for the GPU because it has no GPU access, but it is not an example
of container cleanup. The verified design **preserves uncertainty**.

## Acceptance

Start from the exact clean/pushed D2B commit
`7e0db3f92789cd219e7bbc1909f23277160d6181` on branch
`feature/phase6a-streaming-asr-foundation`. Install using the guarded package,
verify D2C targeted tests, D1/D2A/D2B regressions, full `npm run check`, SDK
build/tests, and isolated PostgreSQL 17 acceptance on JPCMAIN. No source commit,
GitHub push, migration, or deployment is performed by the package.
