# Third-party Adapter SDK v1 — proposed contract

**Status:** draft design; no public independent adapter packaging/install protocol is asserted to exist. Current ASR synthetic test adapter proves portions of a private worker interface, not production third-party extensibility.

## Goal

An independent developer can create a workload (speech ASR, diffusion, simulation, render, embeddings, custom CUDA), package it, and make it runnable on workers where **an operator explicitly approves installation**. The GPULink scheduler, relay, DB and core APIs remain unchanged.

## Contract layers

1. **Metadata / manifest** — stable adapter identity, version, execution API/protocol version, capability names, immutable artifact digest, supported platforms and resource requirements. Current repo already has versioned manifests; inspect their exact schema before defining new fields. Do not unilaterally change `schemaVersion: 2` or declare an unimplemented `entrypoint` field valid.
2. **Admission** — operator-installed adapter catalog; worker declares verified capability and resource envelope. Pin immutable artifact identity when allocating a session; reject incompatible or revoked versions.
3. **Start and readiness** — worker selects installed implementation, starts runtime (possibly a supervised process), enforces startup timeout, then signals workload readiness only after required model/runtime validation. Relay pair acknowledgment means transport is paired, **not** model loaded.
4. **Streaming data plane** — bounded application-defined binary/control payloads, generic session envelope, timeout and cancellation; worker adapter translates protocol to its runtime. No speech tokens or model definitions in the generic relay.
5. **Lifecycle and isolation** — per-session context, AbortSignal/cancellation, lease-loss shutdown, resource cleanup, sanitized logs, no secret exposure, least-privileged process/container/GPU access. Protocol errors may not expose internal paths, stack traces, credentials or model caches.
6. **Consumption accounting** — transport `send()` or native buffer receipt is not consumed GPU work. Optional workload-specific acknowledgments represent precisely documented, testable progress; they must not over-credit scheduler ingress.
7. **Versioning / packaging** — protocol and artifact version independently. Publishing, operator approval, revocation, signature/digest verification, rollback and model/license review are required before open third-party distribution.

## Illustrative contract boundary (NOT current API)

```ts
// A future adapter-author experience, not a shipping import.
export const adapter = defineAdapter({
  capability: 'speech.streaming',
  version: '1.0.0',
  resources: { minVramMiB: 8192 },
  async start(ctx) {
    const engine = await loadApprovedRuntime(ctx.artifacts, ctx.gpu);
    await ctx.ready(engine.identity); // model loaded, not merely socket joined
    return {
      async onData(frame) { await engine.accept(frame); },
      async onCancel() { await engine.stop(); },
      async dispose() { await engine.close(); }
    };
  }
});
```

Keep adapter SDK ergonomics separate from the wire/runtime contract so C++, Python and other runtimes can participate without embedding TypeScript or GPULink Node internals. Consider a language-neutral supervised-process IPC spec with independently authored bindings, **after** real worker-source audit.

## SDK packaging discipline

- Reference adapters must be separately buildable/versionable; no importing undocumented GPULink internal modules in a third-party adapter.
- Stable contract fixture and external package consumer tests required.
- No automatic execution of code supplied by client session messages.
- Model files and native proprietary/vendor libraries remain external artifacts with explicit license/redistribution review.

## Two-adapter proof

The reference ASR adapter plus a second non-ASR adapter (for example, a fixed GPU arithmetic/diagnostic workload with test fixture) must pass the same install, registration, launch, authorization, cancellation and teardown tests **without changes to core scheduling/transport**. Synthetic speech tests alone do not satisfy this.

## DP3B foundation checkpoint (not the completed SDK)

The preliminary implementation described in [operator-approved-adapters-dp3b.md](operator-approved-adapters-dp3b.md) connects an operator-managed **single-file, SHA-256-pinned trusted JavaScript module** to the existing session adapter registry. Its catalog is local configuration rather than a changed public manifest schema. It is not sandboxed, does not provide signed package distribution or process IPC, and must not be presented as safe to execute arbitrary third-party code. The language-neutral supervised-process adapter interface, operator trust system, and cross-language SDK remain future work.
