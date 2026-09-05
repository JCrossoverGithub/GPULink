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

#### `speech.streaming` session payload

The durable job contains only the bounded metadata needed to schedule a TransGo
streaming session. Audio frames, bearer tokens, callback URLs, executable
commands, and transport controls are not accepted in this payload:

```json
{
  "schemaVersion": 1,
  "protocol": "transgo-v1",
  "audio": {
    "encoding": "pcm-s16le",
    "sampleRateHz": 16000,
    "channels": 1,
    "frameDurationMs": 100
  },
  "interimResults": true
}
```

All omitted fields use the values shown above. `interimResults` may be disabled;
the protocol and audio format are otherwise fixed for the first compatibility
version. Unexpected fields are rejected. This contract does not add the
WebSocket data plane or advertise `speech.streaming` from a worker; those are
later Parakeet adapter slices.

#### `benchmark.gpu` payload

The first real CUDA workload is a fixed float32 PyTorch matrix multiplication.
The control plane normalizes and validates its payload before persistence, and
the worker repeats the same validation before launch:

```json
{
  "schemaVersion": 1,
  "matrixSize": 4096,
  "warmupIterations": 3,
  "measuredIterations": 10
}
```

`matrixSize` must be `1024`, `2048`, `4096`, or `8192`. Warmup iterations are
limited to 1–10 and measured iterations to 1–25. Missing fields use the values
shown above. Unexpected fields are rejected. The job cannot select a command,
script, Python module, backend, data type, environment variable, or output path.

The result reports the assigned GPU identity, pinned backend/runtime versions,
median and P95 iteration time, estimated TFLOPS, peak allocated memory, and
worker-owned timestamps. Runner output must match the submitted request and
the exact result schema or the job fails.

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
