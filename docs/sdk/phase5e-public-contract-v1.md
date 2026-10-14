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
