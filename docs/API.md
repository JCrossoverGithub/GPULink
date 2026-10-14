# GPULink API

Every protected route requires a bearer token:

```text
Authorization: Bearer <scoped GPULink token>
```

The current API uses three independently generated credential scopes:

| Credential | Environment variable | Permitted operations |
| --- | --- | --- |
| Client | `GPULINK_CLIENT_TOKEN` | Submit, inspect, list, cancel jobs, and request or close sessions |
| Worker | `GPULINK_WORKER_TOKEN` | Register, heartbeat, discover leases, and advance or renew assigned work |
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

Ready installed adapters are described separately from the capability names:

```json
{
  "capabilities": ["benchmark.gpu"],
  "adapterManifests": [{
    "schemaVersion": 1,
    "type": "benchmark.gpu",
    "version": "1.0.0",
    "executionMode": "bounded-process"
  }],
  "adapterHealth": [{
    "schemaVersion": 1,
    "type": "benchmark.gpu",
    "state": "ready",
    "code": "ready",
    "checkedAt": 1788566400000
  }],
  "modelInventory": [{
    "schemaVersion": 1,
    "modelId": "nvidia/parakeet-tdt-0.6b-v2",
    "revision": "main",
    "adapterType": "speech.streaming"
  }]
}
```

Each manifest type must match an advertised capability. Older workers may omit
`adapterManifests`; the control plane stores an empty list for them. Manifests
contain descriptive metadata only and cannot provide commands, arguments,
environment variables, images, or executable paths.

`adapterHealth` reports every configured adapter as `ready`, `unavailable`, or
`not-installed`. Codes are fixed to `ready`, `readiness_probe_failed`, and
`adapter_not_installed`; raw exception messages are never sent to the control
plane. When health is present, its ready entries must exactly match the worker's
advertised capabilities and manifests. Older workers may omit health.

`modelInventory` contains at most 64 models whose configured local targets the
worker has verified inside its cache root. It contains only model identity,
revision, and intended adapter type; local paths never leave the worker. This
inventory is distinct from `warmModels`, which identifies models already
resident in a running adapter. Older workers may omit model inventory.

### `POST /v1/workers/{workerId}/heartbeat`

Refreshes liveness, capabilities, warm models, verified cached-model inventory,
and bounded GPU telemetry. It also refreshes the versioned manifest for each
ready adapter and bounded adapter health from the same periodic readiness
probe. Cached-model discovery runs on its own bounded interval.

### `GET /v1/workers` (administrator)

Returns the authoritative fleet inventory.

### `POST /v1/workers/{workerId}/drain` (administrator)

Body: `{ "drain": true }` to prevent new leases, or `false` to resume.
Existing jobs are not terminated by entering drain mode.

### `GET /v1/workers/{workerId}/leases`

Returns work currently owned by the worker:

- active `leased` and `running` jobs;
- `allocated`, `connecting`, and `active` sessions.

The response contains separate `jobs` and `sessions` arrays.

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

The durable job contains only the bounded metadata needed to schedule a CaptionLink
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

## Application-facing execution model

GPULink's application-facing contract is intended to support two execution
shapes.

### Jobs

Jobs represent finite work submitted to the durable scheduler.

Applications may:

- submit a validated workload;
- declare capability/resource requirements;
- observe queue/lease/run state;
- wait for completion;
- receive a bounded result;
- inspect durable lifecycle events.

The existing job APIs implement this foundation.

### Sessions

Sessions represent persistent allocations for interactive or
latency-sensitive workloads.

The implemented control-plane lifecycle is:

```text
requested -> allocated -> connecting -> active -> closed
                         |
                         +-> interrupted
```

An interrupted session returns to `requested` only while its bounded
replacement policy permits another allocation. Every replacement receives a
new lease.

#### `POST /v1/sessions`

Creates a durable session request. The optional `Idempotency-Key` header is
scoped to `projectId`. Compatible capacity may be allocated immediately.

#### `GET /v1/sessions`

Lists sessions. Supports `status` and `limit` query parameters.

#### `GET /v1/sessions/{sessionId}`

Returns authoritative durable session state.

#### `POST /v1/sessions/{sessionId}/start`

Worker-only. Moves an unexpired assigned session from `allocated` to
`connecting` using `workerId` and `leaseId`.

#### `POST /v1/sessions/{sessionId}/activate`

Worker-only. Moves an unexpired assigned session from `connecting` to
`active` using `workerId` and `leaseId`.

#### `POST /v1/sessions/{sessionId}/renew`

Worker-only. Renews an unexpired `allocated`, `connecting`, or `active`
session lease.

#### `POST /v1/sessions/{sessionId}/data-plane/client-grant`

Client-only. Returns a short-lived signed data-plane grant bound to the
session's current `sessionId`, `workerId`, and `leaseId`.

The session must currently be `allocated`, `connecting`, or `active`, and its
lease must still be valid.

#### `POST /v1/sessions/{sessionId}/data-plane/worker-grant`

Worker-only. Requires the current `workerId` and `leaseId` in the JSON request
body and returns a worker-role data-plane grant for that exact allocation.

A stale worker or stale lease cannot obtain a replacement grant.

Data-plane grants:

- use a dedicated signing secret rather than the client, worker, or
  administrator bootstrap credentials;
- expire after a short bounded lifetime;
- never outlive the current session lease;
- are not persisted in PostgreSQL;
- are not written to durable lifecycle events;
- must be revalidated against authoritative session state when a data-plane
  connection is established.

A worker replacement changes the authoritative lease ID, so an old grant is
rejected even if its cryptographic expiry time has not yet elapsed.

Worker agents advance an allocated session to `connecting` only when a
session-lease handler is explicitly installed in that worker runtime. A worker
without a session runtime leaves the allocation in `allocated` rather than
claiming that a data plane exists.

While the handler remains attached, the worker renews the exact current
`workerId` + `leaseId`. If lease discovery removes the session or reports a
different lease, the handler is aborted and the old lease stops renewing.

The worker does not mark the session `active` at this stage. `active` is
reserved for the later data-plane establishment step.

#### `POST /v1/sessions/{sessionId}/close`

Client route. Closes a `requested`, `allocated`, `connecting`, or `active`
session and releases any owned worker/GPU lease. Terminal `interrupted`
sessions retain their failure state.

The durable session request contains scheduling metadata only.

Latency-sensitive payloads such as:

- PCM audio frames;
- video frames;
- token streams;
- tensors;
- model-server protocol traffic;

must not be copied into PostgreSQL merely because the compute resource was
scheduled by GPULink.

### Capability requests

Applications should request reusable capabilities rather than hard-code worker
names.

A session request may express requirements such as:

```json
{
  "capability": "speech.streaming",
  "requirements": {
    "minVramMiB": 16384
  }
}
```

The version 1 session request schema is validated by
`src/shared/session-contract.mjs`. Unknown fields are rejected rather than
silently treated as scheduler or transport controls.

Worker selection remains a GPULink responsibility.

### SDK boundary

A future GPULink SDK should wrap stable application-facing APIs rather than
expose deployment internals.

Application code should not need knowledge of:

- AWS;
- K3s;
- PostgreSQL;
- ECR;
- scheduler locks;
- worker heartbeat internals.

See `APPLICATION_FRAMEWORK.md` for the framework and application boundary.

## CaptionLink compatibility naming

The current accessibility application is CaptionLink.

Existing lowercase protocol identifiers such as `transgo-v1` remain unchanged
where they are part of an established compatibility contract. Product naming
does not silently change an on-wire protocol version.

### Session data-plane WebSocket contract

The first GPULink session data plane uses a relayed WebSocket boundary at:

```text
/v1/data-plane
```

The relay protocol is versioned independently from application payload
protocols.

A connection offers exactly two WebSocket subprotocol values:

```text
gpulink.data-plane.v1
gpulink.grant.<short-lived-session-grant>
```

The relay selects only `gpulink.data-plane.v1`; the grant-bearing protocol is
authentication material and must never be echoed back as the selected
subprotocol, written to durable events, or stored in PostgreSQL.

The grant determines the connection role (`client` or `worker`) and binds the
connection to one exact:

```text
sessionId
workerId
leaseId
```

Pairing is therefore scoped to one current allocation. A client connection from
one lease can never pair with the worker connection from another lease.

#### Transport bounds

Version 1 uses the following hard relay limits:

- maximum WebSocket message/frame payload: 1 MiB;
- maximum peer-side buffered amount before overload handling: 4 MiB;
- maximum time waiting for the opposite role to connect: 10 seconds;
- idle connection timeout: 30 seconds.

Applications must chunk payloads larger than the maximum frame size.

The relay is payload-neutral. Text and binary application frames are forwarded
without interpreting application semantics. For example, GPULink Core does not
parse PCM audio, caption JSON, video frames, token streams, or tensors merely
because they pass through the relay.

#### Backpressure

The relay must not build an unbounded in-memory queue.

If the receiving WebSocket has exceeded the bounded buffered-byte threshold,
the relay fails closed instead of continuing to enqueue application frames.

This deliberately favors bounded memory and explicit reconnect/recovery over
unbounded latency growth.

#### Lifecycle boundary

A session remains `connecting` while only one side of the relay exists.

The transition to `active` occurs only after both authenticated roles for the
same current lease have established the data plane.

The relay must revalidate authoritative session/lease state before accepting
each side. Lease replacement invalidates the previous pairing identity.

High-rate application payloads are never persisted to PostgreSQL.

#### Worker relay lifecycle

When a worker runtime has a session handler installed, the worker agent:

1. advances its exact current allocation to `connecting`;
2. requests a worker-role data-plane grant using the current
   `workerId + leaseId`;
3. opens `/v1/data-plane` using the versioned relay subprotocol;
4. passes the authenticated socket to the installed session handler;
5. renews the durable session lease independently of data-plane payload flow;
6. closes the relay socket and aborts the handler if ownership is lost or the
   worker stops.

The worker handler never receives the long-lived worker bearer token or the
short-lived signed grant. It receives only the established socket and
session/runtime context.

The relay remains responsible for changing the durable state from `connecting`
to `active` after both current-lease roles pair.

#### Live relay invalidation

Pair-time authorization is not the final authority for the lifetime of a relay.

The relay subscribes to committed GPULink lifecycle-event notifications.
Whenever authoritative control-plane state changes, active relay pairs are
revalidated against the current session allocation.

A connection is torn down if its signed identity no longer matches the current:

```text
sessionId
workerId
leaseId
```

This closes active stale connections after session closure, interruption, or
replacement without performing a PostgreSQL lookup for every high-rate
application frame.

Relay payload forwarding itself remains an in-memory data-plane operation.

#### Grant expiry versus established sessions

A data-plane grant is a short-lived connection-admission credential.

Its expiry determines whether a new WebSocket connection or pending pair may
be established. Grant expiry does not, by itself, terminate a data plane that
was already authenticated and paired.

After establishment, live authorization is based on the previously verified
claims plus authoritative current session state:

```text
sessionId
workerId
leaseId
lease expiry
session lifecycle state
```

This permits a session to live longer than the short admission-grant TTL while
still failing closed when durable allocation ownership changes.
