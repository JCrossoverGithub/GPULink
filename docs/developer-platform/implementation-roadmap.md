# Developer Platform v1 implementation gates

**Date:** 2026-10-15. **Approved direction:** Direct Client SDK + open third-party Adapter SDK. **Status:** docs/design created; production implementation not begun at this gate.

## Accepted preconditions

- Existing GPULink core scheduler, leases, authenticated data plane and external TS SDK examples are foundations; preserve their exact tested contracts until audited.
- Earlier Phase 6A synthetic ASR E2E and NVIDIA recorded audio CUDA tests proved useful components, **not** browser offload or a public adapter ecosystem.
- Last accepted local checkpoint on JPCMAIN: `feature/phase6a-streaming-asr-foundation`, HEAD `60e31dcbced34b964c1fef2d6da53e623973ebbf`; remote main last verified `bc39f4599588e62d9982ed2dff165a1e65066c40`. Reverify before every mutation. Doc staging makes working tree intentionally dirty; preserve and audit that diff, do not silently bypass safety gates.

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

## Immediate next action after applying docs

Run the bundled read-only source audit on JPCMAIN and share its log. Use results to produce a file-by-file DP1 source map and typed SDK/adapter conformance fixtures before changing application runtime source.
