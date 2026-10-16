# DP3C3B2A — Operator broker threat model and security architecture (RFC)

**Status:** Implemented design/conformance candidate; not a production broker; JPCMAIN gate pending. 2026-10-15.
**Architectural north star:** GPULink is an open-source, multi-language and runtime-neutral GPU platform. The host operator assumes infrastructure-specific responsibility; application developers require only the Client SDK and endpoint.
**Accepted baseline:** DP3C3B1, 38 uncommitted paths, branch `feature/phase6a-streaming-asr-foundation`, HEAD `60e31dcbced34b964c1fef2d6da53e623973ebbf`. The DP3C3B1 acceptance evidence reports 29/29 contract tests, 53/53 subprocess/IPC regression, 356 passed + 22 PostgreSQL skipped root tests, 33/33 Client SDK tests.

## 1. Scope and non-goals

B2A establishes a strictly scoped broker launch *intent* contract and a fail-closed, **non-authoritative** policy snapshot evaluator. It adds no runtime broker service, socket, Docker/Podman calls, workload startup, GPU access, new Client SDK options, trust promotions, runtime installations, commits or production changes. The output always has `canLaunch:false`. A pass proves only conformance for the simulated snapshots, **not** host security or multi-tenant isolation.

All workload trust classes beyond explicitly operator-trusted are rejected in B2A. Future production support for reviewed third-party adapters is conditional on an independently implemented and validated containment backend. Unknown or adversarial multi-tenant workloads are not approved merely by supporting OCI.

## 2. Trust boundaries and principals

| Principal | Controls | Must not control |
|---|---|---|
| Client application | Application capability, data, and authorized project identity through existing SDK/API | Executable, image tag/digest choice, mounts, GPU device assignment, host network, security profile, runtime socket |
| Adapter author | Adapter code, manifest, proposal for artifact publication | Operator approval, host permissions, worker credentials, broker trust tier |
| Worker process | Session relay, current lease observation, requests to broker | Privileged OCI engine, arbitrary host paths, privileged broker policy, authoritative GPU device decisions |
| **Operator-owned broker** | Host-authenticated worker identity, revalidated lease, approved artifact identity, fixed profile, runtime controls and resource allocation | Client-specified process/OCI JSON; accepting worker capability claims as proof of isolation |
| Container/VM workload | Only explicitly provided IPC and bounded data needed to execute | Control-plane credentials, broker channel, engine socket, host-sensitive mounts, other tenants' devices |
| Host kernel/driver/engine | Enforced isolation and GPU access | Cannot be treated as intrinsically secure solely because rootless or OCI is present |

The broker must be a separate least-privilege service where practical; its own access to a privileged engine is *highly sensitive*. Passing through generic Docker API methods or mapping the daemon socket to workloads is forbidden. The future Unix-domain peer identity must be derived from kernel credentials, not supplied as JSON. An authenticated peer is still insufficient without authorization and current lease fencing.

## 3. Threats and expected defenses

| ID | Attack / failure | Required defense | B2A coverage |
|---|---|---|---|
| T01 | Client injects `command`, `hostPath`, or engine options | Fixed input keys, broker-owned launch templates | Strict schema negative tests |
| T02 | Worker impersonation or stolen bearer token | OS-authenticated local peer, separated identities, credential rotation | Design only; fake `caller` record |
| T03 | Replay old session after reassignment | Current lease generation and worker identity checked immediately before launch | Snapshot mismatch tests; no atomic fence |
| T04 | Two workers race to launch same attempt | Durable compare-and-swap / unique attempt claim in broker DB | Snapshot replay shape only; atomicity **not implemented** |
| T05 | Tampered or mutable image tag | Broker-approved immutable digest + dependency closure, digest verification at content access | Digest syntax/binding only |
| T06 | Breakout via privileged mounts, capabilities, root UID, host namespaces | Validated immutable hardening profile, audited runtime config | Required-controls schema only |
| T07 | Access other GPUs or VRAM / device alias | Reservation-derived exact CDI/driver device mapping and host verification | Request denies raw devices; broker-owned mock reservation |
| T08 | Network exfiltration or metadata access | Default-deny egress, DNS and IPv6 protection, network policy enforcement tests | Required-control check only |
| T09 | Resource exhaustion / fork bombs | Enforced memory, CPU, pids, logs, storage and startup/session deadlines | No real enforcement yet |
| T10 | Child processes survive cancellation/restart | Full cgroup/VM lifecycle cleanup + durable orphan reconciliation | Later end-to-end proof needed |
| T11 | Runtime proof supplied by malicious worker | Probe in broker context and independently validate effective configuration | Snapshot test only; no attestation |
| T12 | Model readiness confused with relay readiness | Existing adapter READY and DP3C3A END/exit/worker-ACK remain authoritative | No change to IPC/worker |
| T13 | Runtime failure triggers unsafe subprocess fallback | Isolation properties non-negotiable at scheduling **and** broker admission | B1 and B2A fail-closed policy |
| T14 | Host-driver/kernel escape or shared GPU cross-tenant attack | Stronger VM/node isolation, operator risk controls; no universal guarantees | Explicit unsupported condition |
| T15 | TOCTOU after policy check and before OCI create | Atomic lease/reservation/attempt recheck at actual launch | **Not implemented in B2A** |
| T16 | Broker compromise or unrestricted runtime service | Restricted, audited broker API; secrets protected; broker-level sandbox | Architectural requirement |

## 4. Broker launch-intent protocol (proposed v1)

Intents contain `schemaVersion`, `attemptId`, `sessionId`, `leaseId`, **monotonic `leaseGeneration`**, `runtimeId`, `reservationId`, `artifact:{adapterId,version,sha256}`, and `requiredIpcVersion`. They do not contain executable, tags, runtime flags, filesystems, network modes, environment values, or GPU identifiers.

**The wire-shaped intent is a request, never authority.** In B2B, the broker must independently fetch current authoritative lease state, operator artifact allowlist, atomic reservation state, runtime compliance and an attempt record from its own protected stores. It must bind authorization to an authenticated worker OS identity or mutually authenticated service principal. An arbitrary message arriving on the socket cannot create a workload.

The broker resolves image digest and profile ID from its operator-owned approval catalog. `sha256` in the Adapter identity is distinct from the OCI image manifest digest; a binding between both must be proven. Runtime capabilities are backend-specific and not an assertion of full security. A pool of prewarmed adapters may later have distinct ownership and shareability rules; not B2A.

## 5. Host-independent enforcement profile (target, not implemented)

Minimum required properties in the B2A proposed isolated OCI profile: `process`, `filesystem`, `network`, `identity`, `resource-limits`, `gpu-device`. The class labels `isolated-oci` or `operator-verified` are insufficient proof: the broker must actually validate the effective OCI/VM config and relevant host kernel/driver/namespace controls. This includes an unprivileged container user, stripped capabilities, no privilege escalation, seccomp confinement, writable scratch only, no host secrets or device mounts beyond the verified reservation, no host network/PID/IPC namespaces, deny-by-default network, and cgroup/cpu/memory/pid/storage/log controls.

For GPU devices, use vendor-neutral GPU/resource identifiers in the GPULink core and resolve host-specific devices through a provider adapter. NVIDIA CDI may be a useful implementation, but CDI/device assignment does not imply safe shared-GPU tenancy or VRAM hard limits. Start by testing exclusive allocation until independent protections are proven. GPU vendor support, driver versions and Linux kernels should be discovered, not assumed by SDK users.

## 6. Broker lifecycle and atomicity

```text
Authenticated worker  ──request──> Broker IPC
  Broker loads its own authorizations + current lease + reservation + attempt
  Broker atomically claims attempt after proving current lease generation
  Broker revalidates hardening profile, artifact digest and GPU reservation
  Broker creates workload, persists engine handle and starts bounded supervision
  Broker establishes Adapter IPC transport; worker handles HELLO/READY/END
  Worker alone decides GPULink completion ACK after adapter END/exit success
  Broker tears down complete workload on cancellation, failure or lease expiry
  Broker reconciles durable ownership and orphaned containers after restart
```

Design requirements: no cross-process WeakSet tokens as authorization, no unsafe in-memory-only replay defense, no worker-supplied `verifiedControls`, no operation between decision and launch without a final fence. Broker-created handles must not give callers access to generic engine operations. A failed cleanup must remain observable and retain ownership records for retry; successful process exit is **not** a successful GPULink session.

## 7. Source-specific integration seam

The verified GPULink source retains `WorkerAgent` as the lease/relay orchestrator, `session-adapters.mjs` as the readiness/selection layer, and `approved-subprocess-adapters.mjs` as the DP3C3A successful-completion bridge. In B2A, no existing source path is modified. The future isolated adapter loader should expose the same v2 `handleSession` interface, but use the broker's controlled handle and the **same adapter IPC**; explicit completion remains authorized by the worker after successful adapter completion. Scheduler placement, isolated adapter readiness and final broker admission must be consistent; placement alone cannot confer execution privileges.

## 8. Implementation sequence and acceptance gates

**B2A (this package):** threat model, launch-intent shape, bounded fake broker-owned snapshots, negative tests for lease, replay, artifact, environment/device injection, and profile/IPC mismatch. All outputs are advisory. No host claims.

**B2B (future):** actual broker IPC framing + kernel-derived caller identity; operator-owned local persistent store; atomic fencing of lease and attempt; safe broker socket permissions; recovery/error protocol; design review and adversarial protocol tests with NO engine.

**B2C (future):** implement one carefully selected isolated OCI backend only on a supported Linux GPU host. Independently verify seccomp/namespaces/mounts/network/cgroups/device assignment. Test dangerous flag rejection, cleanup/orphan recovery and quota enforcement. Do not grant worker access to engine socket. Document non-support of malicious multitenant GPU workloads unless separately established.

**B2D (future):** controlled end-to-end integration with WorkerAgent and DP3C3A completion, real GPU and verified exclusive device assignment, lease replacement and worker restart. Additional backends can implement the same interface. PostgreSQL tests (22 previously skipped) remain a separate obligation before full release readiness.

## 9. Primary technical references (current as of 2026-10-15)

- OCI runtime specification: https://specs.opencontainers.org/runtime-spec/
- OCI Linux capability/seccomp/no-new-privileges documentation: https://github.com/opencontainers/runtime-spec/blob/main/config.md
- Docker engine security and privileged daemon risks: https://docs.docker.com/engine/security/
- Docker daemon access security: https://docs.docker.com/engine/security/protect-access/
- Kubernetes Restricted Pod Security Standard: https://kubernetes.io/docs/concepts/security/pod-security-standards/
- NVIDIA Container Toolkit CDI: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html

These are **reference standards**, not evidence of any GPULink host's effective confinement.
