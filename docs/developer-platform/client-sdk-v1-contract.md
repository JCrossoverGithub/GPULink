# Client SDK v1 — proposed public contract

**Status:** design target, not implemented API. Verify naming and existing capabilities against `packages/gpulink-sdk/src`, package exports, `docs/sdk` and actual server routes before implementation. Preserve compatibility with the existing `@gpulink/client` package where feasible.

## Responsibilities

- Discover or request a **capability** and optionally pin a specific adapter identity/version/digest (without embedding workload logic in GPULink core).
- Safely request and open an authorized session, including data-plane pairing and **transport-ready vs workload-ready** distinction.
- Exchange bounded UTF-8 control and binary application data. The SDK must not reinterpret adapter payloads; optional codecs live in separately versioned workload packages.
- Expose state transitions and terminal reasons; support explicit cancellation and deterministic cleanup. Resource cleanup on early abandonment is essential.
- Backpressure: never present socket-buffer admission as inference completion; provide `send()` admission promises and, if an adapter supports consumption acknowledgments, expose them separately.
- Bound queue size, individual frame bytes, memory growth, outstanding sends, and deadline durations. Fail closed on protocol mismatch or worker/lease revocation.
- Typed errors: authentication/permission, no eligible worker, grant expiration, transport interrupted, worker shutdown, model not ready, quota, deadline, unsupported protocol, cancellation.
- Handle reconnection only if a fresh authorized session/grant has been obtained and the adapter's replay/idempotency contract permits it. Do not silently replay PCM or claim seamless ASR state recovery.

## Target shape (ILLUSTRATIVE — DO NOT COPY INTO A RUNNING APP)

```ts
// Proposal; NOT current public SDK API.
const session = await gpu.openSession({
  capability: 'speech.streaming',
  adapter: { id: 'captionlink.multitalker', version: '1.0.0' },
  resources: { minVramMiB: 8192 },
  signal: abortController.signal,
});
await session.waitForWorkloadReady(); // distinct from relay paired
session.onData((frame) => workloadDecoder.consume(frame));
await session.send(pcmFrame);          // accepted for bounded transport, not decoded
await session.close();
```

The **same conceptual state machine** must be implementable in .NET (`IAsyncDisposable`, `CancellationToken`, `IAsyncEnumerable`, `ReadOnlyMemory<byte>`) and JavaScript/TypeScript (`AbortSignal`, async iteration, `Uint8Array`). Do not freeze signatures until source audit and contract tests pass.

## Security surfaces

**Trusted backend:** uses a scoped GPULink client credential. Credentials never enter shipped CaptionLink binaries as universal secrets, public browsers, frontend environment variables, or bundled extension sources.

**Browser/Chromebook:** authenticates to the app's trusted issuer and receives short-lived, single-purpose, session-scoped credentials; uses GPULink SDK over TLS/WSS with origin policy, replay protection, expiry and revocation. Investigate generic token-exchange or delegated-grant endpoint. Merely hiding a long-lived credential in browser code is not acceptable.

**Desktop:** per-user authentication or trusted broker, secure local token storage and least privileges; no admin tokens.

Cross-origin WebSocket policy and consent/privacy disclosure for transmitting microphone and system audio are required, particularly for accessibility scenarios.

## Minimum conformance tests

1. Eligible-worker discovery and mismatch rejection without adapter-specific core code.
2. `relay.ready.v2` does **not** fulfill application `model_ready`/workload-ready.
3. Grant expiry/duplicate/replay and origin mismatch; credential never logged.
4. Clean close, explicit cancel, lease revocation, worker crash, network cut, no leaked sessions.
5. Bounded send, backpressure, typed timeout and exact-once terminal notifications.
6. Tests from **outside the monorepo** using the published SDK artifact only.
7. Browser grant flow and .NET parity, including negative tests.

## Migration from existing SDK

Inventory real exports first: existing `requestSession()`, `connectSession()`, `closeSession()`, v2 readiness, data-plane APIs and example consumers are valuable. Add ergonomic `openSession()` **on top**, with an opt-in migration path. Avoid breaking or reimplementing the wire protocol before a compatibility review.
