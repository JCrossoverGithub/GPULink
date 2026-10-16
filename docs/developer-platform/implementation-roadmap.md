# Developer Platform v1 implementation gates

**Original plan date:** 2026-10-15. **Approved direction:** Direct Client SDK + open third-party Adapter SDK.
**Historical source-audit baseline:** `37dc692d19aa0581f1365c5bce3d721904a8b980` (2026-10-16). The later `8a90539` development branch was accepted and pushed, but not merged into `main` or deployed. See the [living milestone status and evidence index](verified-milestone-status.md) for the later scoped JPCMAIN evidence. This page preserves the original DP0–DP9 gate definitions; its gate descriptions are not a current list of unfinished tasks or public API guarantees.

## Accepted preconditions

- Existing GPULink core scheduler, leases, authenticated data plane and external TS SDK examples are foundations; preserve their exact tested contracts until audited.
- Earlier Phase 6A synthetic ASR E2E and NVIDIA recorded audio CUDA tests proved useful components, **not** browser offload or a public adapter ecosystem.
- **Historical planning checkpoint only:** JPCMAIN then reported `feature/phase6a-streaming-asr-foundation`, HEAD `60e31dcbced34b964c1fef2d6da53e623973ebbf`, and `origin/main` `bc39f4599588e62d9982ed2dff165a1e65066c40`. The later audited **source** baseline is `37dc692d19aa0581f1365c5bce3d721904a8b980`; no current Git HEAD or remote state can be asserted from its source ZIP. Verify actual branch, HEAD and worktree before mutation.

## Sequence

| Gate | Scope | Pass criteria | Writes / authorization |
|---|---|---|---|
| DP0 | Update design docs and read-only source mapping | Decision recorded; exact APIs and CaptionLink files located | Docs only, no commits |
| DP1 | SDK/adapter protocol gap analysis | Versioned contract decisions and security threat model reviewed; no proposed API masquerades as implemented | Design/docs only |
| DP2 | TS public SDK high-level session client | External-consumer tests, v2 readiness, lease, backpressure and abort tests pass | Scoped SDK source after explicit gate |
| DP3 | Public adapter SDK and external package | Independently packaged test adapter registered by operator; no core source changes | Scoped adapter work after gate |
| DP4 | C# .NET SDK parity | Golden protocol vectors pass on TS and .NET; no admin secret in desktop | Scoped SDK work |
| DP5 | Direct CaptionLink provider | Live app streams via SDK; existing local caption engines unaffected | Scoped CaptionLink change |
| DP6 | Existing real multitalker ASR as external adapter | Verified model readiness, bounded VRAM, latency, cancel/revoke safety | GPU executions separately gated |
| DP7 | Browser delegated-grant support | Least-privilege grants, origin/expiry/replay tests; no client secret embedded | Auth/backend review first |
| DP8 | Independent second workload | Non-ASR application/adapter works without touching GPULink core | Separate test |
| DP9 | RC/security/release | Licensing, concurrency, docs, deployment and rollback review | Push/merge/deploy separately approved |

## Explicitly deferred

The previously proposed Phase 6A-6L2C GPULink-specific C++ native-bridge build is **deferred**, not canceled or rejected. It may become a first-class standalone third-party ASR adapter component after the platform contract is stable. Its single-speaker model is not assumed equivalent to CaptionLink's overlapping-speaker pipeline.

## Scope and invariants

No unrelated GPU tests, new model downloads, package installs, certificate/key material, credentials in files, commits, pushes, merges or deployments as part of this docs package. The docs need source-level reconciliation against the live checkouts before implementation claims or API freezing. Any content in `docs/sdk/phase5e-*` remains historical description of accepted behavior, not replaced by proposed v1 design.

## Historical next action at the `37dc692` reconciliation

At that checkpoint, the next action was to reconcile the index against the checkout and qualify independent adapter conformance alongside the Client SDK. Those scoped gates were subsequently exercised on JPCMAIN through `8a90539`; consult the [living milestone index](verified-milestone-status.md) for their exact results and limitations. Repository cleanup and controlled integration into `main` are the immediate maintenance focus. This historical plan does not authorize code changes, a merge, or deployment.
