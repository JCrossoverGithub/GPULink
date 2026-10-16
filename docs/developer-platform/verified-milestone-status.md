# GPULink — verified developer-platform status and milestone evidence

**Status:** source-reconciled documentation candidate; **not yet accepted or merged**.
**Baseline:** `37dc692d19aa0581f1365c5bce3d721904a8b980` (`feature/phase6a-streaming-asr-foundation`, as reported in the handoff).
**Source:** exact user-supplied Git archive; `RELEASE_REVISION` matches the baseline. Git metadata, HEAD, worktree, remote tracking and deployment cannot be verified from this archive.
**Review date:** 2026-10-16.
**Execution:** source inspection only for this reconciliation. No test run, installed package, GPU inference, commit, push, or deployment accompanies this document.

This is the **single living milestone/evidence index** for the developer-platform work. For *planned gate definitions* see [implementation-roadmap.md](implementation-roadmap.md); for *architecture* see [ADR 0001](adr-0001-direct-sdk-platform.md); for the *broader infrastructure phases* see [../ROADMAP.md](../ROADMAP.md). Earlier gate-specific notes remain historical records and can retain their original labels such as `candidate` or `pending JPCMAIN acceptance`. This index does not replace their test artifacts or certify a deployment.

## Boundaries that must not change silently

- **GPULink Core (the drill):** generic control plane, scheduling, worker/GPU inventory, reservations/fences, authenticated sessions, transport, placement, policy and telemetry. No speech-specific behavior in generic Core contracts.
- **Client SDK (application-facing controls):** consumes Core's public HTTP/streaming contracts. No developer-local CUDA, WSL or GPU required to use remote compute; current TypeScript package supports Node >=24.
- **Adapter SDK (drill-bit attachment):** *separate, equally important interface* for developers building independently packaged GPU workloads. Current trusted adapter execution internals do **not** constitute a completed public Adapter SDK or an untrusted-code sandbox.
- **Independent adapters (bits):** ASR, LLM, vision, simulation, etc.; written and distributed without modifying GPULink Core. **Operators** approve, install and control execution environment and trust policies.
- Protocols must be language-neutral and independently versioned. SDK convenience wrappers must not create private Core coupling. An authenticated relay `ready` signal is **transport pairing**, not proof a model is loaded or input consumed.

## Evidence terms

| Term | Meaning |
|---|---|
| **A — development accepted** | Exact implementation and tests exist in baseline; historical JPCMAIN acceptance supplied. Does not imply live deployment, independent third-party release, or GPU isolation. |
| **P — partial product gate** | Some code/decisions exist, but the *named public/user-facing gate* has no complete acceptance evidence. |
| **N — not demonstrated in snapshot** | No implementation or acceptance evidence in this archive for the specified gate; does not prove an external project lacks it. |
| **H — historical operational acceptance** | Earlier recorded deployment/acceptance checkpoint, *not* acceptance of the audited feature branch. |
| **D — deferred** | Explicitly outside the immediate developer-platform closure. |

**Historical acceptance evidence:** The prior D2C terminal record (supplied separately from the Git archive) reports PostgreSQL-enabled root tests **516 passed / 0 failed / 0 skipped**, and `@gpulink/client` **33 passed / 0 failed**, including packed-tarball use by an independent consumer. The handoff also reports targeted PostgreSQL **31/31** and broker/control-plane **44/44**. These are historical results; **nothing was rerun for this reconciliation**. Test source locations below make the evidence auditable, but test existence does not by itself prove passing results. See `docs/developer-platform/synthetic-provenance-handoff-d2c.md` for D2C limitations.

## Official developer-platform gates (DP0–DP9)

| Gate | Status at baseline | Implementation/source evidence | Missing criterion / next decision |
|---|---|---|---|
| **DP0 — design and source mapping** | **P** | `adr-0001-direct-sdk-platform.md`; `client-sdk-v1-contract.md`; `adapter-sdk-v1-contract.md`; source map below | This source-grounded matrix is prepared but not accepted in Git yet. Review/merge it, remove contradictory *current-status* summaries, preserve historical notes. |
| **DP1 — protocol/security review** | **P** | Both SDK contract drafts; `adapter-ipc-v1-dp3c1.md`; `workload-broker-threat-model-dp3c3b2a.md` | Freeze only minimal v1 compatibility/security contract with cross-language golden fixtures. No silent promotion of illustrative APIs to public APIs. |
| **DP2 — public TypeScript Client SDK** | **P; implemented development foundation** | `packages/gpulink-sdk/{package.json,README.md,src/index.ts,src/session.ts,src/data-plane.ts}`; `spec/{client,data-plane,reliability,readiness-v2,external-consumer,high-level-session}.mjs` | `@gpulink/client@0.1.0` remains `private: true` and Node >=24; publication/semver/compatibility policy not accepted. Current `sendBinary`/`sendText` are bounded synchronous methods, not application-consumption ACKs. Model readiness is workload-defined. Preserve existing exports; don't rewrite relay. |
| **DP3 — public independent Adapter SDK** | **P; functioning attachment substrate** | `src/shared/adapter-manifest.mjs`; `src/worker/{adapter-ipc-v1,adapter-subprocess-supervisor,approved-session-adapters,approved-subprocess-adapters,session-adapters,main}.mjs`; `examples/external-adapter/`; `test/approved-*-e2e.test.mjs` | Only `packages/gpulink-sdk/` exists as an SDK package; no independent public Adapter SDK/conformance distribution, artifact/dependency closure or external real-GPU developer proof. Trust is operator-approved, not untrusted sandboxed. |
| **DP4 — .NET Client SDK parity** | **N** | No `.cs` or `.csproj` in snapshot | Public protocol fixtures, shipped .NET client and parity/cancel tests needed. |
| **DP5 — direct CaptionLink client** | **N / external unknown** | `captionlink-direct-sdk.md` design; CaptionLink repo not included | Inspect separate CaptionLink source and prove real provider integration without regressing local mode. |
| **DP6 — real multitalker ASR adapter** | **N for external real-inference proof** | `src/worker/asr-synthetic-*`; `scripts/asr/synthetic_runtime.py`; `test/phase6a-*` | GPU-backed packaged model, model-ready signal, bounded VRAM/latency and integration with independent Client SDK not demonstrated. Historical CUDA benchmarks are separate. |
| **DP7 — browser delegated grants** | **N** | Existing trusted bearer-client and WebSocket grant machinery; see `packages/gpulink-sdk/src/` | No accepted delegated issuer, Origin/expiry/replay conformance or browser-safe trust boundary. Never ship operator/backend secrets to browsers. |
| **DP8 — independent second GPU workload** | **N for required proof** | Trusted echo fixtures and built-in CUDA benchmark are distinct from this gate | External non-ASR GPU-backed adapter + independent consumer without Core edits. |
| **DP9 — release candidate/security/publication** | **N** | `SECURITY.md`, CI, existing operational docs and private SDK package | Independent package/release policy, onboarding, permissions, compatibility, and operator trust-boundary acceptance required. |

**Interpretation:** A working TypeScript SDK is not yet a stable *public v1* release. Working adapter loaders and a language-neutral IPC are not yet an independent *Adapter SDK*. The DP0/DP1 public-contract decisions can be completed without changing the architecture.

## Accepted development milestones nested under DP3

These milestones are **not undone** by open public DP3 acceptance. Status `A` means accepted *within the stated limited scope*, based on source plus historical terminal evidence. Do **not** repeat these same milestones merely to obtain a newer phase name.

| Milestone | Status | Source/test evidence | Limit of acceptance |
|---|---|---|---|
| **DP3B** — trusted ESM loader | **A** | `src/worker/approved-session-adapters.mjs`; `test/approved-session-adapters.test.mjs`; `test/approved-adapter-e2e.test.mjs` | Operator-pinned, trusted single-file ESM; not a sandbox or general publishing path. |
| **DP3C1** — language-neutral IPC | **A** | `src/worker/adapter-ipc-v1.mjs`; `test/adapter-ipc-v1.test.mjs`; `examples/external-adapter/echo-subprocess.py` | `GLIP` v1 bounded framing/handshake; not model readiness. |
| **DP3C2A** — subprocess supervisor | **A** | `src/worker/adapter-subprocess-supervisor.mjs`; `test/adapter-subprocess-supervisor.test.mjs` | Bounded direct child lifecycle; no whole-process-tree containment. |
| **DP3C2B** — approved subprocess path | **A** | `src/worker/approved-subprocess-adapters.mjs`; `src/worker/main.mjs`; `test/approved-subprocess-adapters.test.mjs`; `test/approved-subprocess-e2e.test.mjs` | Operator-pinned executable/assets and synthetic relay; no untrusted-tenant isolation. |
| **DP3C3A** — completion ACK | **A, limited** | `subprocess-completion-and-isolation-dp3c3a.md`; `src/worker/approved-subprocess-adapters.mjs` | Explicit completion and child exit requirements; not proof of physical GPU cleanup. |
| **DP3C3B1** — runtime contract | **A, fake-only** | `src/worker/{workload-runtime-contract,workload-runtime-fake}.mjs`; related tests | Contract and fake lifecycle, not a real isolated launcher. |
| **DP3C3B2A** — broker admission | **A, nonlaunch** | `src/worker/workload-broker-admission.mjs`; `test/workload-broker-admission.test.mjs` | Policy/fail-closed admission; no arbitrary real workload launch. |
| **DP3C3B2B** — Linux broker | **A, test-only** | `src/broker/{broker_server,broker_state}.py`; `src/worker/workload-broker-client.mjs`; `test/workload-broker-b2b.test.mjs` | Peer credentials, bounded journaled claim; nonlaunch/test-only execution boundary. |
| **B2C1** — authority observation | **A, read-only** | `src/control-plane/broker-authority-observation.mjs`; `test/broker-authority-observation.test.mjs` | Observation is not ownership/launch permission. |
| **B2C2B1** — execution-ownership schema | **A, storage** | `src/control-plane/persistence/migrations/postgres/0003-execution-ownership-storage.sql`; `test/execution-ownership-schema-postgres-b2c2b1.test.mjs` | Durable attempts/fences, no inferred GPU cleanup. |
| **B2C2B2A** — scheduler held fence | **A** | `src/control-plane/scheduler.mjs`; `scheduler-resource-fence-b2c2b2a.md` | Held fences prevent scheduling; observation alone cannot release. |
| **B2C2B2B** — atomic claims | **A** | `src/control-plane/execution-claim-authority.mjs`; `atomic-execution-claims-b2c2b2b.md` | Atomic claims are not host runtime attestation. |
| **B2C2B2C1** — broker-scoped claims | **A, nonlaunch** | `src/control-plane/broker-claim-service.mjs`; `test/broker-scoped-claims-b2c2b2c1.test.mjs` | Broker authenticated + scoped; cannot grant execution authority. |
| **B2C2B2C2** — host broker binding | **A, test-only** | `src/broker/broker_authority_bridge.py`; `test/broker-host-binding-b2c2b2c2.test.mjs` | Claim binding does not verify device cleanup. |
| **D1** — read-only reconciliation | **A** | `broker-reconciliation-readonly-d1.md`; `test/broker-reconciliation-readonly-d1.test.mjs` | Held attempt observation, never GPU fence release. |
| **D2A** — host procfs observation | **A, test-only** | `src/broker/host_process_observer.py`; `test/broker-host-procfs-d2a.test.mjs` | Exact Linux process birth observation; `absent` ≠ safe to release. |
| **D2B** — journaled identity | **A, test-only** | `src/broker/host_binding_journal.py`; `test/broker-host-binding-d2b.test.mjs` | Durable broker-measured **operator-hinted** process identity; not a broker-launched workload. |
| **D2C** — broker-origin synthetic helper | **A, test-only** | `src/broker/synthetic_provenance_d2c.py`; `test/broker-synthetic-provenance-d2c.test.mjs` | Fixed GPU-free helper and restart observation; not OCI, GPU ownership, process-tree teardown, or release authority. |

## Broader roadmap (independent of DP sub-gates)

| Roadmap item | Status at source baseline | Evidence and caution |
|---|---|---|
| **Phase 0 — heterogeneous GPU fleet** | **H complete** | `../ROADMAP.md`; historical physical benchmark acceptance, not rerun. |
| **Phase 1 — PostgreSQL** | **H complete; source present** | `src/control-plane/persistence/` and migrations. |
| **Phase 2 — scheduler/event correctness** | **H complete; source present** | Scheduler runner, PostgreSQL advisory locks and event tests. |
| **Phase 3 — production recovery** | **H complete** | Earlier documented operational acceptance. |
| **Phase 4 — AWS/K3s** | **H complete on 2026-10-13** | `../security/aws-phase4e-production-acceptance-2026-10-13.md`; accepted deployed revision `538982e7372b1343cc90dae291151bcf27e9a21e`, **not** `37dc692`. |
| **Phase 5A — application contract** | **P** | Generic concepts/code exist; public compatibility + unrelated app conformance remain. |
| **Phase 5B — persistent sessions** | **A internal; P as public deployment gate** | `src/control-plane/service.mjs`; `test/session-*.test.mjs`. |
| **Phase 5C — authenticated relay** | **A internal; P for service-level evidence** | `src/control-plane/data-plane-relay.mjs`; SDK v2 readiness tests; latency/failure measurements not complete. |
| **Phase 5D — placement** | **A primitives; P real-model validation** | `src/control-plane/scheduler.mjs`; `test/phase5d-*`. |
| **Phase 5E — Client SDK** | **P** | Private TS package; external consumer test. |
| **Phase 6 — reference applications** | **P (synthetic only)** | ASR synthetic tests; external GPU-backed independent integration missing. |
| **Phases 7/8 — multi-user / cross-trust** | **N for product gate** | Some authentication/fencing substrate exists; untrusted-tenancy and GPU containment not demonstrated. |
| **Phase 9 — capacity exchange** | **D** | Concept only. |

## Source-to-developer-interface map

| Interface | Existing implementation (do not duplicate) | Missing independent-user acceptance |
|---|---|---|
| **Client SDK** | `packages/gpulink-sdk/src/{index,session,data-plane}.ts`; v2 authenticated relay; cancellable sessions and authoritative cleanup; external tarball test | Supported v1 release and compatibility/error policy; platform target documented; workload-ready distinct from relay-ready; cross-language parity in later DP4. |
| **Adapter SDK** | `src/shared/{adapter-manifest,adapter-health}.mjs`, `src/worker/{approved-session-adapters,approved-subprocess-adapters,adapter-ipc-v1,adapter-subprocess-supervisor}.mjs` | Independent public authoring/conformance distribution; immutable package/dependency review; external developer can produce an adapter without importing private worker internals; operator-controlled install/revoke. |
| **Core and runtime** | scheduler, service, worker agent, transports, authenticated grants, fencing/broker observation | Operator-trusted integration end-to-end with actual GPU model; separate isolation and whole-tree cleanup acceptance for untrusted execution. |
| **Example workloads** | `examples/external-adapter/echo-stream.mjs`, `echo-subprocess.py`, synthetic ASR | Independently packaged real GPU workload + non-ASR second workload. |

## Next acceptance gates — existing DP roadmap, no new phase IDs

**0. DP0/DP1 status consolidation (immediate, documentation only).** Verify this matrix, links and historical test citations against the exact checkout; approve/commit docs without changing runtime or public API. Require `git status` and SHA guards on the actual developer machine. **Pass:** every DP0–DP9 row and accepted nested development milestone is source-linked, scope-limited and reviewed; no contradictory "not begun" current-status guidance remains.

**1. DP1+DP3 minimal language-neutral conformance kit.** Inventory implemented `GLIP` framing/handshake, manifest `schemaVersion:2`, current catalog schema and trust modes; publish reusable fixtures, negative cases, and external-directory tests without changing protocol semantics. A separate developer directory supplies Python or C++ adapter implementation (not an import of Core worker modules) to an operator-approved catalog. **Pass:** exact schema/IPC/version-negative cases, cancellation/reap, integrity mutation/restart/revoke scenarios and explicit trusted-only limitations. A fake GPU is acceptable for *contract* proof, not real inference.

**2. DP2 Client SDK public-contract qualification, in parallel where independent.** Preserve existing low-level API and `openSession`; pin runtime, export, error, compatibility and semantic-version policy and build from a clean independently installed tarball. Require grant expiry, relay pairing, aborted allocation, disconnect, bounded buffering, authoritative release and no false model-ready or consumption claims. **Pass:** external application runs finite + streaming paths using only the packaged SDK, not Core imports; the accepted tests remain green. Browser delegated auth and .NET parity are *separate* gates.

**3. DP3+DP6 full real-GPU proof.** The approved independently packaged workload executes a pinned model on a dedicated operator-trusted GPU worker. A separately packaged Client SDK consumer streams data, obtains accurate workload-ready/consumed/complete signals, and handles loss/revocation without false release. **Pass:** no Core edits, reproducible install/approval/restart, model identity, bounded memory/VRAM, latency/throughput numbers and actual GPU inference. **Do not equate** D2C synthetic provenance with this gate.

**4. DP4/DP5/DP8, followed by DP7/DP9 as separately warranted.** .NET and CaptionLink source review, then an unrelated GPU adapter, and finally browser security/release acceptance. Don't rework functioning broker guarantees merely to increase milestone count.

## Risks, non-goals and change control

- No Core redesign, new phase names, separate SDK repositories, application-specific scheduler fields, models, installs or production deployment are implied by this index.
- Do not run untrusted adapters on privileged or general production workers. Hash pinning and cancellation of one subprocess are **not** containment, sandboxing, publisher identity verification, full dependency pinning, GPU cleanup or safe fence release.
- A `model_ready` / completion signal belongs to a versioned workload contract. GPULink's generic relay cannot infer inference progress from WebSocket buffering or IPC stdin writes.
- The existing DP3B–D2C evidence **must not** be relabeled as public SDK acceptance. Hold/quarantine policy remains fail-closed when cleanup evidence is uncertain.
- If the actual branch has diverged from `37dc692`, rebase the **documentation decisions** against live files and their new tests before merging, rather than applying this historical status as if still current.

## Maintenance contract

Update this file only with source-grounded evidence. Each change to a milestone status must include: (1) the accepted commit SHA or explicitly "pending", (2) exact changed source/test paths, (3) reproducible test or review artifact and its date/environment, (4) the capability/limitations proven, and (5) product gaps still open. Record source status separately from production deployment and public release. Preserve historical gate documents as evidence, not competing current roadmaps.
