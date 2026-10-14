# GPULink opt-in relay readiness v2 (Phase 5E-3F1)

Status: experimental. This change adds a v2 readiness signal to the existing `/v1/data-plane` WebSocket relay while preserving the original v1 protocol. It is **not** model readiness or a production rollout.

## Negotiation

Clients continue to supply exactly two WebSocket subprotocol values: one supported data-plane version and `gpulink.grant.<short-lived-token>`. Supported version values are `gpulink.data-plane.v1` and `gpulink.data-plane.v2`. A mixed offer with both version values is rejected. This step does not change `createDataPlaneProtocols(grant)`: the existing worker and application integrations continue to offer v1.

## Versioned signaling

Once both current grants have been revalidated, the session has been activated, and the relay has linked the two live sockets and installed forwarding handlers, the relay sends exactly one text control frame `gpulink.relay.ready.v2` to each connected **v2** endpoint. It sends no such frame to any v1 endpoint. A v2 client may pair with an existing v1 worker; no v1 worker update is required for this handshake.

The relay refuses to forward a peer-sent matching control frame to a v2 endpoint; it closes the pair with protocol error 1002. This prevents an application peer from spoofing the server's readiness marker. No other v1/v1 frame handling is changed.

The ready message proves transport authorization, pairing, and forwarding activation only. It does not establish that the application's GPU model is loaded, initialized, or able to infer. SDK consumption of v2 and removal of the legacy 30 ms delay will follow in a separate gated patch.

## No fallback and deployment coordination

When an SDK later opts into v2, it must verify v2 negotiation and the readiness frame, failing closed when either is missing. It must never silently downgrade from v2 to v1. Existing clients may explicitly continue on v1 until rollout completes. No deployment or restart is performed by this development step.

## TypeScript SDK opt-in (Phase 5E-3F2)

The experimental TypeScript client supports `connectSession(id, { protocolVersion: 2 })`. It offers only `gpulink.data-plane.v2` plus the existing short-lived grant and does not offer or silently downgrade to v1. It waits for the exact server-origin `gpulink.relay.ready.v2` text control frame, bounded by the connection deadline and optional abort signal. The control frame is consumed by the SDK and never emitted as application payload; bounded early peer data is preserved for the first message listener. The default remains the legacy v1 path to avoid breaking existing servers and clients.

No model-ready assertion, automatic reconnect, reuse of expired grants, worker lease operations, or production rollout is included.
