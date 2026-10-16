# GPULink Developer Platform v1 — design and implementation evidence

> **Current feature checkpoint:** `8a90539f42bd9c169f3ae0a3e28c1bfc2c78c8e5` (accepted and pushed on the development branch, 2026-10-16). Start with the [living evidence index](verified-milestone-status.md); the original 2026-10-15 designs and gate reports are retained as historical decisions. Neither SDK has a completed public v1 release, and this feature branch is not merged into `main` or deployed.

**Status:** approved architectural direction, **not** a declaration of implemented SDK v1 behavior.  
**Decision date:** 2026-10-15.  
**Initial reference consumer:** CaptionLink.  
**Initial reference workload:** developer-owned streaming speech recognition adapter.  
**Owner boundary:** GPULink core is an application-agnostic GPU execution substrate, not a speech product.

Read in this order (implemented development interfaces first, historical proposals afterward):

1. [Living milestone and evidence index](verified-milestone-status.md) — current accepted scope and open gates.
2. [Client SDK](../../packages/gpulink-sdk/README.md) and [Adapter SDK](../../packages/gpulink-adapter-sdk/README.md) — actual pre-v1 packages.
3. [Adapter SDK compatibility contract](adapter-sdk-developer-contract-v0.1.md) and [operator-reviewed package workflow](operator-trusted-adapter-package-workflow.md) — accepted experimental author/operator path.
4. [Architecture decision (ADR 0001)](adr-0001-direct-sdk-platform.md) — the generic Core / independent SDK boundaries.
5. [Original Client SDK v1 proposal](client-sdk-v1-contract.md), [Adapter SDK v1 proposal](adapter-sdk-v1-contract.md), and [planned gates](implementation-roadmap.md) — historical targets, not shipping API declarations.
6. [CaptionLink integration design](captionlink-direct-sdk.md) and [original trusted-loader evidence](operator-approved-adapters-dp3b.md) — reference materials, not generic Core requirements.

**DP3 independent packaging (scoped JPCMAIN acceptance, October 16, 2026):** [Operator-trusted package workflow](operator-trusted-adapter-package-workflow.md) documents an accepted portable single-file bundle, independent npm consumer gate, and manual operator catalog review. The authoring SDK remains private and pre-v1; this is not signed distribution, complete dependency pinning, or untrusted isolation.

**DP3 versioned developer contract (scoped JPCMAIN acceptance, October 16, 2026):** [Adapter SDK developer compatibility contract](adapter-sdk-developer-contract-v0.1.md) records independently installed npm compatibility exports and a separately packaged physical CUDA workload through the existing operator-approved loader and Client SDK. The SDK remains experimental, private and pre-v1; no new Core/runtime or public release is claimed.

**External adapter-author conformance candidate:** [`packages/gpulink-adapter-sdk/README.md`](../../packages/gpulink-adapter-sdk/README.md) documents a deliberately small, not-yet-public GLIP v1 echo-profile tester. This complements the existing worker-side tests; it does not replace the adapter contract or establish DP3 completion.

## Historical 2026-10-15 design checkpoint (superseded)

The original design package recorded the GPULink development checkpoint on JPCMAIN at local branch `feature/phase6a-streaming-asr-foundation`, commit `60e31dcbced34b964c1fef2d6da53e623973ebbf` (eight local commits above `bc39f4599588e62d9982ed2dff165a1e65066c40`). These are *local* findings; nothing in these documents claims that the public main branch or AWS deployment contains these changes.

The existing `@gpulink/client` TypeScript SDK, authenticated session relay, streaming protocol v2 and external consumer examples should be extended rather than replaced. The current ASR synthetic adapter is test-only. NVIDIA CUDA whole-file and recorded-WAV streaming inference were accepted at earlier gates, and the installed native C ABI was inspected, but a persistent real streaming adapter is not implemented yet.

## Deliberate non-goals

- Building a CaptionLink-specific compatibility gateway first.
- Moving CaptionLink's application logic into GPULink core.
- Rewriting an already working caption UI or speech pipeline to prove orchestration.
- Allowing arbitrary untrusted client code to run on GPU workers.
- Claiming an SDK API, package, model readiness, third-party package format or browser auth flow is production-ready before code and tests verify it.
- Making the single-speaker Nemotron candidate an automatic replacement for CaptionLink's working multitalker/diarization system.

## Change management

This docs package is **proposal and planning only**. No model download, inference, package installation, native build, runtime deployment, credential provisioning, commit, push, merge or production change is authorized by applying these documents. API names and manifest fields in proposals are explicitly illustrative until source-level verification and conformance tests freeze the v1 interfaces.

## DP3B implementation checkpoint (historical heading, superseded)

At the time of this design note, the operator-approved local catalog loader was under test. At the `37dc692` source checkpoint, DP3B and later limited-scope milestones have implementation and historical acceptance evidence. This **still does not** constitute general third-party package distribution or isolation; read [DP3B boundary and caveats](operator-approved-adapters-dp3b.md). DP0 proposals still describe the target public platform, not a frozen v1 API.
