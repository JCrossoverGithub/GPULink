# GPULink DP3C3B2B — Broker IPC and crash-safe attempt ledger

Status: **NON-EXECUTING CONFORMANCE IMPLEMENTATION**; operator review required before live-broker engineering. 2026-10-15.

## Architecture first

GPULink is a general-purpose, open-source and language-neutral GPU platform. Application Client SDKs require no WSL, Linux container engine, GPU driver or local GPU. The broker is an **operator-side** implementation detail. Linux is the initial broker-transport backend, **not a requirement imposed on all GPULink developers**. The protocol's versioned framing is independent of JavaScript/Python, while peer identity is transport-specific.

The accepted B1 runtime abstraction remains below `WorkerAgent` session and relay ownership. The B2A broker launch intent is preserved without adding commands, images, paths, devices or engine options to worker messages.

## What is implemented in B2B

- Python stdlib, Linux AF_UNIX `SO_PEERCRED` broker **test server** with a 4-byte big-endian length-prefixed UTF-8 JSON protocol. Frame sizes are capped at 16 KiB; responses at 4 KiB; duplicate JSON keys, nonfinite numbers and unsupported operations fail closed.
- A Node.js worker-side **test client** supporting only `claim`, `inspect` and `cancel`. It does not accept host commands, environment variables, GPU identifiers, paths or runtime-engine options. It rejects unexpected launch authority.
- Operator-owned **synthetic** fixtures loaded from a local file supplied to the test broker at startup. The broker obtains peer UID from the kernel, resolves UID-to-worker identity internally, verifies fixture-backed lease generation, reservation, approved immutable artifact and simulated profile. Worker messages NEVER carry their own authorization snapshots.
- A SQLite WAL journal with `BEGIN IMMEDIATE`, unique attempt identity and unique reservation identity, durable audit state, a kernel `flock` singleton lock and fail-closed recovery: any previously `reserved` attempt becomes `quarantined` after broker restart. Repeated claims, replay and resurrection fail.
- A fixed, explicit `--test-only` server switch. There is **no production mode**. Each admission acknowledgment includes `canLaunch:false`; **there is no OCI invocation, process launcher, GPU mapping, data-plane wiring or authorization to run a model**.

## Critical limits — NOT production security

The synthetic fixture is NOT a current authoritative lease read from GPULink's control plane, not a real GPU reservation, and not a verified host security profile. SQLite's atomic claim does not create a cross-service atomic transaction with the scheduler/control plane. It would be unsafe to replace a synthetic fixture with a worker-supplied cache, static JSON loaded from the application's repository, or a long-lived stale snapshot.

Peer UID proves an OS account for a **local Linux socket**, but it is not enough if a compromised worker shares the broker's Unix identity or can edit broker state/fixtures. These tests deliberately run broker and worker under the same account because they require no privilege setup. Production isolation requires distinct OS principals, a protected socket directory, secure broker data ownership, controlled group/ACL permissions, broker server identity verification, and careful protection from process/socket impersonation. `SO_PEERCRED` is not portable to arbitrary Windows/macOS transports and does not authenticate any remote TCP peer.

The test server refuses existing socket files instead of opportunistically deleting them; an operator must securely handle stale socket ownership in the eventual service manager integration. The server handles one bounded request per connection and serially accepts clients; the ledger's atomic uniqueness is still exercised under concurrent requests. Rate limiting, monitoring, transport cancellation, audit export, protocol evolution, HA broker leadership and operational rollout remain open.

A broker restart quarantines *attempt tickets*, not real orphaned containers: B2B cannot create any. Production recovery must enumerate engine-managed resources and reconcile ownership while ensuring current lease fencing. The journal is not a replacement for authoritative control-plane persistence.

## Protocol v1 (test only)

Request wire JSON includes precisely `schemaVersion`, `operation` and `payload` (no credentials or caller declarations). `operation` must be `claim`, `inspect`, or `cancel`. `claim.payload.intent` is the exact B2A `schemaVersion:1` launch intent with `attemptId`, `sessionId`, `leaseId`, `leaseGeneration`, `runtimeId`, `reservationId`, `artifact:{adapterId,version,sha256}`, `requiredIpcVersion`.

Response `{schemaVersion:1,ok:true,result:{...,canLaunch:false}}` or `{schemaVersion:1,ok:false,code:'bounded_error'}`. The client must treat all non-boolean or missing `canLaunch` fields as protocol failure. The worker must never interpret an advisory claim as permission to connect an engine.

## End-to-end milestones

- **B2B now**: authenticated local Linux peer transport (test mode), strict versioned framing, fixture-backed admission, journal ownership and fail-closed restart behavior. No adapter starts. Full JPCMAIN tests pending.
- **Next authority gate**: replace fixture provider behind the broker with *independently authenticated, current* lease/reservation/artifact authority; define transaction/compare-and-swap semantics around final execution; verify principal separation and authoritative revocation signals. Include crash/restart and lease replacement races before launch authority can ever exist.
- **B2C host isolation**: a restricted broker-owned OCI backend with exact immutable image digest, namespaces/seccomp/no-new-privileges, network egress deny, bounded filesystem/cgroups, exclusive verified GPU assignment, controlled process tree and supervised cleanup. Certify one supported Linux host at a time, no claims about arbitrary shared GPU multi-tenancy.
- **B2D controlled integration**: adapter startup and IPC, worker readiness and authenticated relay, DP3C3A END/exit/completion acknowledgment, session lease/cancellation and real device access. No unsafe fallback to trusted subprocess for isolated requests.

## Acceptance matrix

`test/workload-broker-b2b.test.mjs` covers: genuine AF_UNIX request/response; `SO_PEERCRED` rejection for wrong peer UID; exact input shapes and disallowed commands/devices; stale/expired lease, trust and profile failures; durable claim/cancel/inspect; concurrent replay fencing; restart quarantine; single writer locking; invalid JSON duplicate keys/nonfinite literals; oversized frames; rejection of fabricated caller credential fields; **refusal to start without explicit test mode**. Run B1/B2A and full source/SDK regression with JPCMAIN guards; PostgreSQL integration tests remain a separate gate when DB config is available.

## References

- Linux `SO_PEERCRED`: https://man7.org/linux/man-pages/man7/unix.7.html
- SQLite WAL/locking: https://www.sqlite.org/wal.html and https://www.sqlite.org/lang_transaction.html
- OCI runtime specification: https://specs.opencontainers.org/runtime-spec/

These references describe mechanisms, not a certified GPULink production host.
