# Developer Platform v1 implementation gates

**Original plan date:** 2026-10-15. **Approved direction:** Direct Client SDK + open third-party Adapter SDK.
**Current evidence baseline:** source archive `37dc692d19aa0581f1365c5bce3d721904a8b980` (2026-10-16 reconciliation, pending repository acceptance). See the [verified milestone status and evidence index](verified-milestone-status.md) for **current implementation and acceptance status**. The original wording "production implementation not begun" described this *initial design gate*, not the source state at `37dc692`. This page preserves the originally planned DP0–DP9 gate definitions; do not treat its historical checkpoints as the current checkout.

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

## Current next action following the source reconciliation

Review and accept the [verified milestone status and evidence index](verified-milestone-status.md) against the real checkout; it is the file-by-file source map for the `37dc692` baseline. Then close DP1's *minimal existing-protocol* compatibility and threat-boundary decisions, and pursue independently consumable Adapter SDK conformance alongside Client SDK v1 qualification. Do not duplicate previously accepted DP3B–D2C work. Any implementation, test execution, commit, push or deploy remains separately gated by the operator's normal checks.
