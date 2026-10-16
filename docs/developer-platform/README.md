# GPULink Developer Platform v1 — design and implementation evidence

> **Current checkpoint:** Read [verified milestone status and evidence](verified-milestone-status.md) first. The initial proposal and checkpoint notes below record the state of the *2026-10-15 design package*, **not** the later accepted DP3B–D2C implementations in the `37dc692` source snapshot. Public v1 SDK contracts are **not** yet declared complete.

**Status:** approved architectural direction, **not** a declaration of implemented SDK v1 behavior.  
**Decision date:** 2026-10-15.  
**Initial reference consumer:** CaptionLink.  
**Initial reference workload:** developer-owned streaming speech recognition adapter.  
**Owner boundary:** GPULink core is an application-agnostic GPU execution substrate, not a speech product.

Read in this order:

1. [Verified milestone status and evidence](verified-milestone-status.md)
2. [Architecture decision (ADR 0001)](adr-0001-direct-sdk-platform.md)
3. [Client SDK contract proposal](client-sdk-v1-contract.md)
4. [Third-party adapter contract proposal](adapter-sdk-v1-contract.md)
5. [CaptionLink direct SDK integration](captionlink-direct-sdk.md)
6. [Development gates and acceptance criteria](implementation-roadmap.md)
7. [DP3B operator-approved adapter loader (trusted-code prototype)](operator-approved-adapters-dp3b.md)

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
