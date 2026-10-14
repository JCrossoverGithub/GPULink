# GPULink TypeScript SDK (Phase 5E)

Experimental application client for GPULink's existing `/v1` HTTP contract.

- Authenticates with a client-scoped bearer token.
- Exposes finite jobs and persistent-session operations, plus client-grant issuance.
- Uses HTTPS except for local loopback development.
- Rejects HTTP redirects to avoid forwarding bearer credentials to another origin.
- Does not expose worker lease renewal, administrator events, or scheduler internals.
- WebSocket streaming, capability discovery, richer runtime schemas, packaging policy,
  and C# / Python bindings follow in subsequent Phase 5E slices.

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
- Peer pairing has no explicit application-level ready-ACK in v1; integration
  tests validate successful exchange against the actual relay. A later wire
  contract can add stronger ready acknowledgement if needed.
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
