# DP3C3B1 — portable workload runtime contract (candidate)

**Status:** Implemented as an isolated contract + fake-runtime conformance candidate. Not accepted on JPCMAIN until the guarded gates pass. Not wired into production worker paths. Not an isolation backend.

## Source-verified integration findings (October 15, 2026)

Reviewed the exact 123-file export, SHA-256 `8db1aa7818840df9bf0e7205974be6dea4bcc0faa2547237e8719894e75879ac`.

- `src/worker/agent.mjs`: `WorkerAgent` owns registration/heartbeat, adapter readiness, lease renewal and cancellation, and authenticated WebSocket relay. `#maintainSessionLease` calls the selected v2 `handleSession(connecting, { signal, gpu, dataPlaneSocket, ... })`. Keep this boundary.
- `src/worker/session-adapters.mjs`: validates v2 streaming adapter manifests, readiness probes and adapter-ID selection. Readiness is **adapter health**, not runtime isolation certification.
- `src/worker/approved-subprocess-adapters.mjs`: operator-owned, default-disabled catalog; validates pinned command/executable/assets and adapts the subprocess supervisor to the WebSocket. It owns the optional DP3C3A explicit-text END/worker completion ACK semantics. Do not move its ACK into a runtime handle.
- `src/worker/adapter-subprocess-supervisor.mjs`: directly uses `spawn`, bounded stdin/stdout/stderr and IPC HELLO/READY/END. It is same-UID supervised execution, **not** containment; cancellation currently targets the direct process rather than a proven OS-enforced workload group.
- `src/worker/adapter-ipc-v1.mjs`: the language-neutral framing contract. No byte changes needed.
- `src/worker/main.mjs`: loads trusted in-process and supervised subprocess catalogs. It does not register an isolated third-party runtime today.
- `src/worker/gpu-inventory.mjs`: existing physical discovery is NVIDIA-centric. Runtime-independent admission must not imply GPU-vendor portability is already implemented.
- `src/shared/session-contract.mjs`: there is no public `requiredIsolation` field today. Do not add host-runtime details to the client request contract just to implement B1.
- Existing session grant/lease paths are authoritative for session ownership; an attempt ID for a future OCI backend must be fenced by the live lease at launch, not assumed safe from a one-time scheduler decision.

## New files and exact scope

1. `src/worker/workload-runtime-contract.mjs`: strict internal v1 runtime report, immutable artifact, admission policy and workload request validators; deterministic selection, unknown-field rejection, explicit trusted-process opt-in; no fallback for missing required isolation; always deny non-operator-trusted execution in B1.
2. `src/worker/workload-runtime-fake.mjs`: synthetic in-memory lifecycle (`inspect`, `prepare`, `start`, `waitForExit`, `terminate`, `dispose`, `reconcile`) with unique attempt identity and fault injection. No processes, sockets, GPUs, or containers are started.
3. Two self-contained `node:test` suites: policy/validation/selection, fake lifecycle/races/cleanup/conformance across two fake runtimes.

**No existing worker, adapter, SDK, session API, protocol framing, scheduler, or production registration is modified in B1.** This separation is intentional: B1 validates contracts without silently rerouting active sessions. DP3C3B2 will require a distinct, operator-approved isolated catalog/driver and authenticated runtime broker. The only launch enforcement of the new admission logic today is within the fake conformance backend; the existing trusted subprocess path retains its existing operator controls and risks.

## Contract behavior

- Artifact approval is exact `(adapterId, semantic version, sha256)` and stored in operator policy. A SHA-256 hash is an integrity identifier, **not** a safety judgment or a substitute for supply-chain validation.
- `WorkloadRequest` includes the session ID, lease ID and a unique **attempt** ID. The request is constructed internally; client data must never set executable, mounted paths or runtime trust.
- `RuntimeReport` identifies runtime ID/kind, availability, adapter IPC support, isolation properties, and a verification designation. `simulated` is **never evidence of kernel isolation**. `operator-verified` is a schema vocabulary reserved for future broker-backed independently validated host evidence; accepting that string is not certification.
- `selectWorkloadRuntime()` yields a **branded, in-process, frozen admission object** that a fake cannot accept if forged. This is not a cryptographically signed admission token and cannot be used between processes as proof of authority.
- An unavailable backend, unsupported IPC version, disabled trusted process, missing isolation property, unknown artifact, or any third-party trust class fails with a bounded code. `allowSimulation` must be deliberately enabled for fake conformance; it MUST be false in real operator policy.
- Deterministic runtime choice is based on an operator-enabled runtime list, then sorted ID; this is **not scheduling for hardware capacity**. Hardware reservations, quotas, physical isolation, concurrency/overcommit and admission during worker restart belong to later milestones.
- A fake `waitForExit()` reports raw process exit only. It cannot satisfy DP3C3A end-of-stream, IPC END acknowledgment, transport acknowledgment or authoritative session close.
- Fake `reconcile()` demonstrates orphan semantics in one in-memory runtime lifetime; it is **not crash-safe** durable workload reclamation. B2 requires durable attempt ownership, generation fencing and broker-side reconciliation across restarts.

## Integration seam for B2 (not yet wired)

Do not replace `WorkerAgent.#maintainSessionLease` or `selectSessionHandler`. Add a distinct operator-approved isolated adapter registration path whose `handleSession()` performs:

1. Acquire a **fresh, lease-fenced operator policy decision** and broker admission; confirm the backend can enforce required properties.
2. Reserve device resources atomically for that attempt, then prepare/start workload with an opaque handle; avoid passing raw host commands from clients.
3. Connect the existing Adapter IPC v1 framing over the broker-owned transport and only report adapter readiness after the strict READY handshake.
4. Reuse/abstract the already-tested session bridge semantics, keeping DP3C3A ACK authority at the worker layer, *not* in a runtime backend.
5. On abort, deadline, disconnect, lease replacement, startup failure or shutdown, tear down the complete workload and reconcile resources. Never downgrade to trusted subprocess on isolated-runtime failure.

Future broker responsibilities include operator-authenticated launch requests, independently verified artifact digests, restricted device access, containment, quotas, network policy, process-tree cleanup and durable reconciliation. These are **not** provided by this module.

## Local evidence and remaining acceptance

- Snapshot manifest: 123/123 SHA-256 records matched the uploaded archive (33 original changed paths).
- New B1 contract/fake tests: **29/29 passed** locally on an extracted source snapshot using Node's built-in test runner. This is not JPCMAIN acceptance.
- Existing source-only IPC/supervisor test subset attempted locally; test results were incomplete because the exact source export intentionally excluded `examples/external-adapter/echo-subprocess.py`, which those tests spawn. JPCMAIN retains that fixture; full regression must run there.
- Required JPCMAIN gates: 29 new tests, DP3C3A targeted tests, full `npm run check`, SDK build/tests, final exact-path/hashes, and reported PostgreSQL skips. Do not call B1 accepted until those pass.

## Non-goals / prohibitions

No Podman/Docker installation, real GPU inference, OCI security claims, universal operating-system support, changes to CaptionLink, commits, pushes, merges or deployments. No production trust/certification inferred from fake runtime tests. No production secrets, credential values or private keys belong in this repo.
