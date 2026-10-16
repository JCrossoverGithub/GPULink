# GPULink application-facing protocol inventory — Phase 5E

Status: development contract inventory; not an independent API compatibility promise.
Source of truth: `src/control-plane/http-server.mjs`,
`src/shared/session-contract.mjs`, and `src/shared/data-plane-contract.mjs`.

## Current client-scope HTTP v1 operations

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/jobs` | Submit finite job; accepts `Idempotency-Key` |
| GET | `/v1/jobs` | List jobs; optional `status` and `limit` (1..500) |
| GET | `/v1/jobs/:id` | Fetch one job |
| POST | `/v1/jobs/:id/cancel` | Cancel job |
| POST | `/v1/sessions` | Request a persistent session; accepts `Idempotency-Key` |
| GET | `/v1/sessions` | List sessions; optional `status` and `limit` (1..500) |
| GET | `/v1/sessions/:id` | Fetch session/allocation state |
| POST | `/v1/sessions/:id/close` | Close session |
| POST | `/v1/sessions/:id/data-plane/client-grant` | Issue short-lived session-bound client grant |

All client routes use `Authorization: Bearer <client-token>`.
Success responses are JSON envelopes (`job`, `jobs`, `session`, `sessions`, or
`grant`). Submit responses include `duplicate`; error responses have `error.code`
and `error.message`. The SDK preserves server errors without inventing statuses.

## Existing streaming wire contract (next SDK slice)

The WebSocket route is `/v1/data-plane` at the same origin, over `wss:` in
production. The client first requests a grant through the authorized HTTP API.
The WebSocket handshake offers `gpulink.data-plane.v1` and
`gpulink.grant.<issued-token>` as two subprotocols. The relay enforces a 1 MiB
frame limit and bounded buffering. Grants must never be logged or placed in URLs.
The worker must join the same currently valid session allocation to pair.

## Explicitly excluded from normal client scope

- `/v1/events`: administrator-only SSE.
- `/v1/sessions/:id/{start,activate,renew}`: worker-only lease actions.
- `/v1/workers`: administrator-only; not a client capability-discovery API.
- `/v1/scheduler/run`: administrator-only.

Client capability discovery and client-scoped event observation are deferred
until explicit public endpoints/contracts exist. SDK clients may poll their
own job/session records under existing v1 authorization; they must not query
PostgreSQL directly or drive the scheduler.

The SDK uses TypeScript source, emits Node ESM and `.d.ts` declarations, and
will remain independent of internal GPULink modules. C# and Python clients
will consume this same HTTP/WebSocket protocol without importing TypeScript.

## Phase 5E-2: first public streaming SDK implementation

The Node.js SDK uses the native `WebSocket` interface, offers exactly the
`gpulink.data-plane.v1` and `gpulink.grant.<short-lived-token>` subprotocols,
then checks that the negotiated protocol is the expected data-plane version.
It never puts grants in URL paths/query strings and does not invent a second
control-plane authentication scheme.

`connectSession()` waits until the authorized session record reaches `active`
before returning an application stream. Only the allocated worker can activate
the pair; the SDK does not call worker `start`, `activate`, or `renew` routes.
The v1 relay has no explicit data-plane-ready acknowledgment, so readiness is
based on control-plane session state plus connection liveness and validated
end-to-end relay tests. Clients must not assume an `open` WebSocket is paired.

The first SDK provides bounded sends, binary and text events, close notification,
and a bounded peer wait. It does not silently reconnect or reserve buffer space
for user callbacks. Receipt of data-plane messages does not imply durable
persistence of audio/tokens or arbitrary stream payloads.

## Phase 5E-3B: client connection budget and cancellation

The optional client `AbortSignal` and `connectTimeoutMs` apply to the full
connection attempt, including grant issuance, WebSocket negotiation, and session
status polling. No client cancellation or timeout mutates authoritative lease
state. There is no automatic grant reuse or retry. A later, separately versioned
relay readiness acknowledgment remains outside this patch.

---

### GPULink Developer Platform v1 (decision 2026-10-15)

The historical Phase 5E SDK contract above remains descriptive of its accepted implementation; it has not been replaced. The forward-looking, **unimplemented** direct Client SDK / open third-party Adapter SDK direction is recorded in [`../developer-platform/README.md`](../developer-platform/README.md), including [ADR 0001](../developer-platform/adr-0001-direct-sdk-platform.md) and the [Client SDK proposal](../developer-platform/client-sdk-v1-contract.md). No CaptionLink-specific compatibility gateway is a prerequisite for greenfield apps.
