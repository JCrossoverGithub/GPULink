# GPUlink API

Every protected route requires a bearer token:

```text
Authorization: Bearer <scoped GPUlink token>
```

The first operational target uses three independently generated credentials:

| Credential | Environment variable | Permitted operations |
| --- | --- | --- |
| Client | `GPULINK_CLIENT_TOKEN` | Submit, inspect, list, and cancel jobs |
| Worker | `GPULINK_WORKER_TOKEN` | Register, heartbeat, lease, start, renew, and finish |
| Administrator | `GPULINK_ADMIN_TOKEN` | Fleet inventory, metrics, events, drain/resume, and manual reconciliation; also accepted on client and worker routes |

Tokens must be at least 32 characters and all three values must differ. These
bootstrap credentials are stored only in root-readable service environment
files. Per-identity, revocable credentials are planned before multi-user use.

`GET /healthz` and `GET /readyz` are unauthenticated for local process and
reverse-proxy health checks.

## Workers

### `POST /v1/workers/register`

Registers a worker by stable name. Re-registering the same name restores its
existing control-plane identity.

### `POST /v1/workers/{workerId}/heartbeat`

Refreshes liveness, capabilities, warm-model inventory, and bounded GPU
telemetry.

### `GET /v1/workers` (administrator)

Returns the authoritative fleet inventory.

### `POST /v1/workers/{workerId}/drain` (administrator)

Body: `{ "drain": true }` to prevent new leases, or `false` to resume.
Existing jobs are not terminated by entering drain mode.

### `GET /v1/workers/{workerId}/leases`

Returns the worker's active `leased` and `running` jobs.

## Jobs

### `POST /v1/jobs`

Creates a durable queued job. The optional `Idempotency-Key` header is scoped
to `projectId`.

Relevant request fields:

```json
{
  "projectId": "transgo",
  "type": "speech.streaming",
  "priority": 100,
  "constraints": {
    "gpuCount": 1,
    "minVramMiB": 8192,
    "capabilities": ["speech.streaming"],
    "model": "nvidia/parakeet-unified-en-0.6b"
  },
  "payload": {},
  "maxAttempts": 3
}
```

### `GET /v1/jobs`

Supports `status` and `limit` query parameters.

### `GET /v1/jobs/{jobId}`

Returns authoritative job state.

### `POST /v1/jobs/{jobId}/start`

The assigned worker supplies `workerId` and `leaseId`. An expired lease is
rejected.

### `POST /v1/jobs/{jobId}/renew`

Extends a running lease. The request must arrive before its current expiry.

### `POST /v1/jobs/{jobId}/finish`

Reports `succeeded` or `failed` with an optional result or structured error.
Only the current, unexpired lease holder may finish the job.

### `POST /v1/jobs/{jobId}/cancel`

Moves a nonterminal job to `cancelled`. The worker detects that the lease is no
longer active and aborts its adapter.

## Operations

### `GET /v1/events` (administrator)

Server-sent event stream. Send `Last-Event-ID` to replay retained events after
a disconnect.

### `GET /metrics` (administrator)

Prometheus exposition for worker and job lifecycle counts. NVIDIA hardware
telemetry will be scraped independently from DCGM Exporter on each worker.

### `POST /v1/scheduler/run` (administrator)

Runs one authenticated reconciliation cycle. Intended for testing and
administrative recovery; the control plane also runs reconciliation on a timer.
