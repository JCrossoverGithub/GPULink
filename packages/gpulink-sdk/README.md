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
