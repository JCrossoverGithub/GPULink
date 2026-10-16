# GPULink Developer Platform v1 — design package

**Status:** approved architectural direction, **not** a declaration of implemented SDK v1 behavior.  
**Decision date:** 2026-10-15.  
**Initial reference consumer:** CaptionLink.  
**Initial reference workload:** developer-owned streaming speech recognition adapter.  
**Owner boundary:** GPULink core is an application-agnostic GPU execution substrate, not a speech product.

Read in this order:

1. [Architecture decision (ADR 0001)](adr-0001-direct-sdk-platform.md)
2. [Client SDK contract proposal](client-sdk-v1-contract.md)
3. [Third-party adapter contract proposal](adapter-sdk-v1-contract.md)
4. [CaptionLink direct SDK integration](captionlink-direct-sdk.md)
5. [Development gates and acceptance criteria](implementation-roadmap.md)
6. [DP3B operator-approved adapter loader (trusted-code prototype)](operator-approved-adapters-dp3b.md)

## What is already known

The accepted GPULink development checkpoint is on JPCMAIN at local branch `feature/phase6a-streaming-asr-foundation`, commit `60e31dcbced34b964c1fef2d6da53e623973ebbf` (eight local commits above `bc39f4599588e62d9982ed2dff165a1e65066c40`). These are *local* findings; nothing in these documents claims that the public main branch or AWS deployment contains these changes.

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

## DP3B implementation checkpoint (pending JPCMAIN acceptance)

A new operator-approved local catalog loader is under test. It does **not** yet constitute general third-party package distribution or isolation; read [DP3B boundary and caveats](operator-approved-adapters-dp3b.md). DP0 proposals still describe the target public platform, not a frozen v1 API.
