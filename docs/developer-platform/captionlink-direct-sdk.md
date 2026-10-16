# CaptionLink direct GPULink SDK integration

**Status:** integration design; exact current CaptionLink source paths/interfaces require a local read-only audit against the user's checkout before editing. This is intentionally **not** a compatibility gateway proposal.

## Outcome

A Windows CaptionLink provider (and later a browser/Chromebook provider) streams audio directly with GPULink's public SDK. GPULink chooses a suitable GPU worker with an operator-installed, CaptionLink-maintained ASR adapter; results flow back through the authenticated GPULink data plane. CaptionLink retains audio capture, caption overlay, speaker semantics and existing local provider fallback.

## Primary implementation choices

- **Direct SDK:** add GPULink client transport behind CaptionLink's existing transcription/provider interface; no translation service whose sole purpose is CaptionLink protocol compatibility.
- **Reuse the *currently working* speech runtime:** package CaptionLink's existing Parakeet/Multitalker and (where required) Sortformer/Nemotron services as an independently managed adapter. Do not block this integration on the new NeMo-Speech.cpp single-speaker native C bridge.
- **Workload codec belongs with adapter/consumer:** leverage existing normalized PCM format and caption event semantics where useful, but keep these message definitions outside GPULink core. Negotiate version explicitly, avoiding accidental mix of CaptionLink remote framing and GPULink ASR v1 `ASR1` framing.
- **Client selection:** configuration switch chooses local inference vs GPULink provider; never change core caption business logic to accommodate scheduler internals.
- **Browser:** requires browser-safe delegated credentials; the first server-side auth issuer is not an ASR gateway and must be generally reusable for any GPULink workload.
- **Transport:** GPULink authenticates/relays. Workload decides interpretation of binary/control frames. Worker supports multiple client sessions only after real capacity/isolation tests.

## Source audit before editing CaptionLink

Audit the checked-out branch and exact file paths for the WPF provider abstraction, remote provider, audio normalization / chunk timing, caption event model, Chrome extension remote path, desktop settings/DI registration, local model processes and GPU gateway. Previous project references mention `CaptionLink.Speech.Remote`, `CaptionLink.GpuGateway`, and `CaptionLink.Remote.Protocol`, but these **must be verified** in the current repository rather than assumed.

Audit GPULink's real TypeScript SDK, worker adapter registry, manifest validation, session grant/lease endpoints, browser CORS/Origin policy, package fixtures, SDK and worker tests. Record actual exported API names, and only then define C# parity.

## Delivery slices (no throwaway gateway)

| Slice | Work | Acceptance |
|---|---|---|
| C0 | Source audit | File- and method-level mapping; no changes |
| C1 | Public TS SDK contract and tests | Existing external consumers still pass; no core speech assumptions |
| C2 | Public adapter contract/package and tests | Developer-owned synthetic adapter runs externally; no core modifications |
| C3 | .NET SDK with shared protocol fixtures | Direct authorized streaming and cancellation parity |
| C4 | CaptionLink GPULink provider | Existing overlay consumes remote results; old local path works |
| C5 | Existing real speech pipeline packaged | Verified model readiness, real GPU allocation, latency measured |
| C6 | Browser/Chromebook | Session-scoped grants; no embedded long-lived credentials |
| C7 | Independent non-ASR adapter | Validates extensibility claims |

## Acceptance for the envisioned Chromebook demo

User-owned browser client captures audio with appropriate permission; SDK requests a session through the safe delegated-auth flow; GPULink allocates an eligible worker; an approved adapter with the existing accurate multitalker backend runs; partial/final captions arrive with correct speaker semantics; closure or lease revoke releases resources. This must be validated under real network latency and user privacy constraints, not inferred from a recorded-WAV benchmark.

## Failure and privacy

Loss of GPU worker must not silently reuse a stale session or replay sensitive audio. Show app-level state (reconnecting/unavailable), attempt a *fresh* authorized session only under explicit policy, and fall back locally where supported. Do not log speech audio, transcripts, tokens or exact host addresses by default. Do not treat public browser packaging as authorization to collect system audio outside browser permission constraints.
