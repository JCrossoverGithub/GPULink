# ADR 0001 — GPULink as a third-party-extensible GPU execution platform

- **Status:** Accepted architectural direction (implementation pending).
- **Date:** 2026-10-15.
- **Decision:** First-class direct GPULink Client SDK plus independent third-party Adapter SDK/contract.

## Context

GPULink was built to let a lightweight application offload GPU-bound work onto GPUs managed by GPULink. CaptionLink is an initial independent client, not a special case: e.g. a Chromebook/browser client can capture audio while an operator-approved adapter runs GPU speech inference on a remote worker. Applications must not need to embed scheduling, GPUs, model lifecycle or relay details.

Analogy: GPULink is the drill and defines the bit attachment; independent developers create the bits (adapters) and applications consume them.

Existing infrastructure includes GPU discovery/scheduling, authenticated sessions, leases, TypeScript SDK primitives, worker adapter registration, and test-only streaming ASR. These are useful building blocks, not evidence that arbitrary third-party adapter distribution or a browser-safe public SDK is complete.

## Decision

1. **Core remains workload-agnostic.** GPU discovery, placement, admission, isolation, lifecycle, transport, authentication, observation and accounting live in GPULink. Speech-specific messages, model details, PCM formats and transcript semantics do not enter the core scheduler or generic relay.
2. **Applications depend on Client SDKs.** The first targets are TypeScript for Node/browser and C#/.NET for CaptionLink Windows. They expose capability-based sessions with bounded bidirectional application data and lifecycle events. Keep a lower-level transport API available for advanced users.
3. **Adapter authors own computation.** A separate adapter contract allows developers to package and install workers providing arbitrary approved capabilities. The native speech bridge is a *reference adapter dependency*, not an intrinsic platform component.
4. **Workers execute only operator-approved adapters.** No generic client-uploaded executable/code execution. Verify artifact identity, version/digest, permission policy and resource envelope before admission. Preserve deployment-agnostic TLS and secret-handling rules.
5. **Clients use controlled GPULink transport.** Direct SDK integration does not mean unauthenticated peer access to GPU machines. The scheduler controls selection, grants, leases and relay mediation.
6. **Browser credentials are delegated.** No long-lived control-plane client/admin token in a web bundle, extension or distributed config. Provide generic origin- and scope-constrained delegated grants issued through an authenticated trusted application backend or dedicated generic token broker. This broker is a security component, not a workload-specific compatibility gateway. If the existing control plane cannot safely issue browser grants, a scoped server-side issuing component is a prerequisite for browser delivery.
7. **No CaptionLink compatibility gateway as default.** A compatibility gateway may be optional for legacy clients and migrations, but must not be needed for greenfield integrations.
8. **CaptionLink stays independent.** Keep existing capture, captions, diarization and engine interfaces. Implement a GPULink provider consuming the public SDK, preserving existing local fallback if desired.

## Platform boundaries

| Responsibility | GPULink core | Client SDK | Adapter SDK / worker adapter | CaptionLink |
|---|---|---|---|---|
| Scheduler, GPU resource admission | Yes | No | Describes requirements | No |
| Session grants and leases | Yes | Wraps protocols | Honors cancellation | Uses API |
| Transport framing, authentication | Yes | Implements | Implements approved endpoint | Uses SDK |
| Workload-specific payloads | Opaque bounded bytes | Pass-through / opt-in codec | Defines schema and processing | Defines user behavior |
| Model selection, inference semantics | Capability metadata only | Requested capability | Owns model/backend | Selects provider |
| Capture, caption display, speaker UI | No | No | Emits workload output | Yes |
| Adapter installation and authorization | Operator policy | No | Packaged, declared, verified | No |

## Alternatives considered

**CaptionLink-specific gateway first:** lower migration cost and no immediate new C# SDK; rejected as the default because it creates a workload-specific protocol translation tier, extra operational surface, duplicates authorization/failure semantics and postpones the reusable SDK contract.

**Build inference directly into CaptionLink:** convenient for one Windows app, but precludes a generic remote GPU service for many other applications. Existing local inference remains an optional provider.

**Require all adapters be written/maintained by GPULink:** limits extensibility and violates the platform thesis.

## Risks / explicit tradeoffs

The direct route requires versioned SDK compatibility, browser credential delegation, .NET support, public adapter packaging/isolation, controlled session recovery, and cross-language conformance tests before an end-user experience can be claimed. The platform's investment is justified by extensibility but not automatically by first-demo speed. No promise of zero-latency cross-network streams; measure capture-to-caption delay over real networks.

## Architectural acceptance test

A developer with **no write access to GPULink core** can publish an approved custom adapter and an independent application can invoke it through a public SDK on a low-powered client. A second materially different adapter works via the same public contracts. Neither requires a scheduler/control-plane source change. End-to-end authentication, data limits, cancellation, worker failure and cleanup pass conformance tests.
