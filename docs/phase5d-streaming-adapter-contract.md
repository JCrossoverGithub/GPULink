# Phase 5D — Versioned Streaming Adapter Contract

## Scope and status

Phase 5D introduces identity-aware session scheduling and worker
routing for version 2 streaming adapters.

This is an infrastructure contract, not a production installation
of a speech, vision, or other model implementation.

The standard production worker entrypoint currently constructs
`new WorkerAgent(loadWorkerConfig())` without registering any
v2 session adapters.

## Adapter implementation requirements

An installed streaming adapter must provide:

- A validated v2 manifest with `schemaVersion: 2`.
- A capability `type`.
- A unique, stable `adapterId`.
- `executionMode: "streaming-gateway"`.
- An executable `handleSession` function.
- A `readinessProbe` function.

Adapters are supplied through the WorkerAgent `sessionAdapters`
option. The registry accepts at most 64 adapters and rejects
duplicate identities.

Registered adapter identities are ordered deterministically.

## Readiness contract

A probe must return exactly `true` to establish readiness.

False results, thrown errors, rejected promises, and deadlines
produce an unavailable health report with code
`readiness_probe_failed`.

Version 2 readiness reports identify the adapter by both
capability type and adapter ID.

A ready adapter contributes its capability and manifest to the
worker advertisement. Unavailable adapters do not contribute a
ready manifest or capability independently.

Multiple implementations may share a capability type.

Probe errors are not included in advertised health reports.

## Probe timing and limitations

| Setting | Default |
| --- | --- |
| Worker heartbeat | 5,000 ms |
| Assignment polling | 1,000 ms |
| Capability-probe interval | 300,000 ms |
| Individual v2 probe deadline | 5,000 ms |

The capability-probe interval is configured with
`GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS` and currently
applies to the worker's combined capability refresh.

The individual v2 probe deadline is configurable through the
`probeSessionAdapters` options argument and is bounded to
1 through 300,000 milliseconds.

Probes execute concurrently. Their results retain deterministic
registry order.

Timeouts bound how long the worker awaits asynchronous probes.
They do not forcibly terminate uncooperative asynchronous work
or interrupt synchronous event-loop blocking operations.

The five-second deadline does not imply a five-second
readiness-refresh frequency.

## Scheduling and handler identity

A session explicitly requesting `requirements.adapter` may be
placed only on a worker advertising the exact ready v2 identity
for its required capability.

The scheduler continues to enforce worker freshness, drain
state, capability constraints, GPU memory, and whole-GPU
exclusivity.

The worker selects the exact registered implementation for a
pinned session. It does not fall back to another adapter or the
legacy generic session handler when that pinned implementation
is missing or unavailable.

Unpinned sessions retain deterministic ready-adapter selection
and the existing generic-handler fallback behavior.

Readiness loss prevents new allocations after the corresponding
worker state is refreshed. Readiness reporting does not by
itself guarantee immediate termination of an existing session.

## Production activation boundary

Version 2 streaming adapters are not installed by the
default worker entrypoint.

Before enabling a real v2 implementation:

1. Register a concrete streaming handler and readiness probe.
2. Confirm GPU and model runtime resource requirements.
3. Set and evaluate a suitable readiness-refresh interval.
4. Test readiness loss during startup and active execution.
5. Verify authenticated session transport and clean shutdown.
6. Re-run SQLite and PostgreSQL integration gates.

A separate v2-specific refresh cadence is recommended before
production activation so frequent streaming readiness checks
do not unnecessarily increase legacy diagnostic probing.

No real model implementation is certified by Phase 5D alone.

## Acceptance evidence

The Phase 5D local acceptance run completed on 2026-10-14:

- 202 Node tests executed.
- 202 passed.
- Zero failures, cancellations, or skips.
- PostgreSQL 17 integration tests executed using an isolated
  disposable local container.
- The temporary PostgreSQL container was removed.
- The existing development PostgreSQL container was preserved.

The acceptance run did not deploy to DigitalOcean or AWS.

## Future work

Production installation of concrete v2 adapters, independent
v2 readiness-refresh scheduling, and real-model performance
validation are separate implementation milestones.
