# GPULink TypeScript SDK (Phase 5E)

Experimental application client for GPULink's existing `/v1` HTTP contract.

- Authenticates with a client-scoped bearer token.
- Exposes finite jobs and persistent-session operations, plus client-grant issuance.
- Uses HTTPS except for local loopback development.
- Rejects HTTP redirects to avoid forwarding bearer credentials to another origin.
- Does not expose worker lease renewal, administrator events, or scheduler internals.
- Authenticated WebSocket streaming supports legacy v1 and opt-in relay readiness v2.
- Capability discovery, richer runtime schemas, publication policy, and C# / Python
  bindings remain future work.

Run `npm ci --ignore-scripts && npm run build && npm test` inside this package.
This package is private until compatibility and security acceptance are complete.

## Authenticated streaming (Phase 5E-2)

`await client.connectSession(sessionId, { connectTimeoutMs: 8000 })` requests
its own client-scoped grant, opens the authenticated `/v1/data-plane` WebSocket,
and waits for the currently allocated worker to pair. Do not call this before
worker session-start; worker lease actions remain outside the client SDK.
The returned stream supports `sendBinary`, `sendText`, `onMessage`, `onClose`,
and `close`. Incoming binary frames are `Uint8Array`; text is a string.

- Node 24's built-in WebSocket is the only transport dependency.
- The library refuses non-loopback unencrypted HTTP and derives `wss:` for HTTPS.
- Grants travel only in the required WebSocket subprotocol offer, never in URLs,
  durable scheduler data, public exceptions, or application logs.
- The local send boundary is 1 MiB per frame and 4 MiB of buffered frames.
- The relay terminates unpaired connections after 10 seconds and idle streams
  after 30 seconds; a client must arrange its own traffic/keepalive policy.
- `connectSession` polls the authorized session until `active`; it cannot
  manufacture an allocation or override lease expiration/worker loss.
- Legacy v1 has no explicit ready-ACK and retains a compatibility delay.
  Opt-in v2 requires the server-origin readiness frame described below.
- No automatic retry or reconnect is performed. Callers must inspect the
  current session/lease and request a fresh grant before reconnecting.

## Phase 5E-3B connection deadlines and cancellation

`connectSession(id, { connectTimeoutMs, signal })` applies one connection
budget across grant acquisition, WebSocket negotiation, and session polling.
Use an `AbortController` to cancel an in-progress connection. The SDK closes
an opened stream if cancellation or timeout happens before connection returns.
On a native WebSocket still in CONNECTING state, cancellation rejects promptly;
if the handshake later succeeds, the SDK closes that late-opened socket.
The underlying native handshake may not be physically interruptible.

No automatic reconnect is performed, and cancelling a connection does not close
or release the GPULink session lease itself. Use `closeSession()` separately.
Pairing readiness still relies on control-plane state and a compatibility delay;
v1 does not provide a protocol-level ready acknowledgment.

## Opt-in relay readiness v2 (experimental)

`connectSession(id, { protocolVersion: 2 })` requests the exact `gpulink.data-plane.v2` WebSocket subprotocol and waits for the server-origin `gpulink.relay.ready.v2` text frame before returning. The SDK consumes the control frame; it is not application data. Both the short-lived grant and the entire readiness wait are covered by `connectTimeoutMs` and `signal` cancellation. v2 does not poll session status or use the v1 30 ms delay.

The default remains protocol v1 for compatibility with already-deployed relays. A v2 request **never silently falls back to v1**. Roll out the compatible relay before opting in to v2. The ready frame means the authorized relay is paired, **not** that a GPU model is initialized. No automatic reconnection, grant reuse, or lease recovery is implemented.

## DP1: high-level authenticated streaming session (experimental)

Use `client.openSession(request, { allocationTimeoutMs, connectTimeoutMs, signal })`
from a trusted application/service to create a GPU session, wait for worker
activation, and connect using the **v2 authenticated relay protocol**. It
returns `GPULinkSession` with `id`, `onMessage`, `onClose`, `sendBinary`,
`sendText`, and `await close()`. Use `try/finally` for guaranteed closure.
DP2 adds `onError`, `lastError`, and bounded `errors` diagnostics.
This method adds no adapter-specific message format and requires no changes to
GPULink Core. `request.projectId` and `request.capability` are still required.

```js
const session = await client.openSession({
  projectId: 'my-project',
  capability: 'example.streaming',
  requirements: { adapter: 'vendor.example.v1', minVramMiB: 1024 },
});
try {
  session.onMessage(frame => { /* parse your adapter's own protocol */ });
  session.sendBinary(new Uint8Array([1, 2, 3]));
} finally {
  await session.close();
}
```

**Contracts and limitations:**

- `openSession()` waits for control-plane session state `connecting` or `active`
  before requesting a short-lived grant. It does not bypass the worker's lease
  lifecycle or guarantee prompt scheduling.
- `gpulink.relay.ready.v2` signifies **relay pairing only**. Applications must
  wait separately for the adapter's *model-ready* message before sending audio
  or other workload data when required by that adapter's protocol.
- `sendText` / `sendBinary` inherit the existing 1 MiB frame and 4 MiB local
  buffered WebSocket limits. They do **not** acknowledge workload processing,
  grant ASR audio credit, or implement incoming application-queue backpressure.
- Unexpected transport closure now triggers one best-effort authoritative
  `closeSession` request automatically. Still call `await session.close()` in
  `finally`: it waits for closure and allows retries after a release failure.
  Setup failures attempt to release the session automatically; cleanup failure
  produces an `AggregateError`. No automatic reconnect is performed.
- Initial session creation is not interrupted mid-request because Core may
  allocate a session while its HTTP response is in flight. Caller cancellation
  is checked immediately after the session ID is received and then triggers
  cleanup. An HTTP failure with an unknown server-side outcome remains an
  unresolved idempotency/reconciliation limitation.
- SDK v0.1.0 currently requires a client-scoped bearer token and targets
  Node 24+. **Do not embed long-lived credentials in browsers or extensions.**
  Browser-scoped delegated-grant issuance and a .NET SDK are separate gates.
- The high-level session buffers up to 256 early inbound messages, capped at
  4 MiB, so an adapter's first readiness message is not lost before the app
  attaches its first listener. Queue overflow closes the session fail-closed,
  records `EARLY_BUFFER_OVERFLOW`, and attempts authoritative lease release.
- Application `onMessage`, `onClose`, and `onError` callbacks are exception-isolated.
  Diagnostic callbacks report only stable codes and generic messages; they never
  serialize thrown application errors or credentials. `lastError` and `errors`
  allow later subscribers to inspect up to 16 buffered SDK diagnostics. This
  is not a replacement for application logs or workload-level ACKs.
- The SDK is experimental/private; `openSession()` does not yet certify a
  public, semver-stable Developer Platform v1 API.
