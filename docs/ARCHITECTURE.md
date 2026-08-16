# Architecture

## Product boundary

The platform is a resource control system. It does not know how Parakeet,
vLLM, llama.cpp, or an image model performs inference.

The control plane owns:

- identity and admission;
- worker and GPU inventory;
- scheduling constraints and priorities;
- exclusive GPU leases;
- worker liveness and drain state;
- retry and terminal failure decisions;
- durable job state;
- operational events and metrics.

The worker owns:

- local GPU discovery and telemetry;
- model and adapter availability reporting;
- acceptance of a valid lease;
- launching an allowlisted workload adapter;
- reporting start, completion, failure, and cancellation;
- local cleanup after a lease ends.

A workload adapter owns:

- model loading and unloading;
- model-specific request validation;
- inference protocol translation;
- model-level health and metrics;
- graceful cancellation and cleanup.

TransGo continues to own audio capture, the 16 kHz mono PCM contract,
interim/final caption rendering, and client reconnection behavior. Its existing
`/v1/transcription` WebSocket protocol will be preserved by a TransGo adapter.

## Control and data planes

Scheduling and lifecycle operations go through the control plane. Large or
latency-sensitive workload data should not be placed into the durable scheduler
database.

For streaming transcription, the control plane will grant a lease and the
gateway will connect the client session to the leased Parakeet adapter. Audio
frames remain on the streaming data path. For LLM serving, GPUlink's native
platform API remains authoritative. An optional OpenAI-format compatibility
adapter may later let existing LLM tools call local models without redefining
GPUlink's scheduling or identity model.

## Deployment topology

The public DigitalOcean droplet runs the control plane in a resource-bounded,
read-only Docker container. Docker publishes it only on loopback, while the
droplet's existing Nginx service is the public listener and terminates HTTPS.
Each Windows GPU host runs the worker under WSL2 and initiates outbound HTTPS
requests to the droplet; no worker port is exposed to the internet. Workers can
be drained before gaming, maintenance, or desktop-heavy work and resumed
without changing their identity.

## Durable state machine

Jobs use these states:

```text
queued -> leased -> running -> succeeded
   |         |         |
   |         |         +-------> failed
   |         +-----------------> queued (expired lease, retry allowed)
   +---------------------------> cancelled
```

The database is the authority. Events are an ordered operational projection,
not the source of truth. The control plane retains the most recent 10,000
events so high-frequency operation cannot grow the event table without bound.

## Reliability invariants

1. A GPU has at most one active `leased` or `running` job in Milestone 1.
2. A drained or stale worker receives no new leases.
3. A lease has an explicit expiry time and attempt number.
4. Start, renewal, and completion are rejected after the lease expiry time.
5. An expired lease is requeued only while attempts remain.
6. Terminal jobs are never rescheduled.
7. Scheduler decisions are made inside a database transaction.
8. Job completion is accepted only from the worker holding the active lease.
9. Idempotency keys prevent accidental duplicate job submission per project.
10. Worker telemetry is bounded and validated before persistence.
11. User payload content is never copied into metrics labels.

## Scheduling policy

Milestone 1 supports one GPU per job. A worker is eligible when it is online,
not draining, fresh enough, and advertises every required capability. A GPU is
eligible when it is not leased and its reported free VRAM, minus the configured
safety margin, satisfies `minVramMiB`.

Eligible placements are ordered by:

1. warm-model match;
2. lowest current GPU utilization;
3. smallest sufficient VRAM headroom;
4. stable worker/GPU identity for deterministic ties.

The smallest-sufficient preference prevents small jobs from consuming the
largest GPU unnecessarily.

## Security boundary

The first operational target has separate client, worker, and administrator
bootstrap tokens. The administrator token is a deliberate super-scope for
single-owner recovery. The service refuses short or duplicated tokens. HTTPS is
mandatory for internet traffic, secrets live in root-readable environment
files, and workers make outbound-only connections. Later milestones replace
the bootstrap credentials with hashed, individually revocable project and
worker credentials.

Workers will execute only configured adapter manifests. Arbitrary command,
Python, shell, and container submission is intentionally excluded.

The llama.cpp RPC backend is not part of the trusted platform data plane.

## TransGo compatibility

The future TransGo adapter preserves:

- WebSocket path `/v1/transcription`;
- subprotocol `transgo-v1`;
- browser token subprotocol `transgo-token.<token>` during migration;
- start-session and `session_started` handshake;
- binary 100 ms PCM chunks at 16 kHz mono;
- sequence IDs and interim/final caption messages;
- health checks and decoder input guards;
- P50/P95/P99 capture, queue, inference, and render timing.

The adapter will translate those semantics into a scheduler lease without
requiring changes to the existing TransGo clients during the first migration.
