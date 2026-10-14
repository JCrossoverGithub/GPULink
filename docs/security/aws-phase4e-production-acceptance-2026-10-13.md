# AWS Phase 4E Production Acceptance

Date: 2026-10-13

## Decision

Phase 4E production migration is accepted.

AWS/K3s is now the authoritative GPULink production control-plane and
PostgreSQL environment.

The former DigitalOcean production deployment remains frozen and retained only
as a rollback target. Its control plane must not be restarted while AWS is
authoritative.

DigitalOcean retirement requires a separate explicit operator decision after
the rollback window is intentionally closed.

## Accepted source

Migration and final production acceptance were performed from repository
revision:

    538982e7372b1343cc90dae291151bcf27e9a21e

## Final frozen DigitalOcean state

Before migration, authoritative DigitalOcean writes were frozen.

Final captured application state:

    workers:             3
    jobs:                20
    events:              316
    max event sequence:  316
    active jobs:         0

Authoritative worker identities:

    worker_766649c57e5940a2950e714754e28302  desktop-3070ti
    worker_919b0b1b6c744e6bb5936ba2ada127c7  jpcmain-3090ti
    worker_f17584e0471d4c7ebaac9c40473b7a6f  laptop-4060

Canonical final DigitalOcean migration backup:

    /var/backups/gpulink/postgres/backup-20261006T225345Z

Dump:

    gpulink-postgres.dump

SHA-256:

    b986f7109761715b7a03898a2080adb06c839c94b82e89fce2ee0e679ed107fe

The DigitalOcean control plane remained stopped after the freeze.

## AWS restore and promotion

The DigitalOcean backup was transferred to AWS and restored into an isolated
PostgreSQL database before promotion.

Validation confirmed:

    workers:             3
    jobs:                20
    events:              316
    max event sequence:  316
    active jobs:         0

Worker identities, migration history, core schema, constraints, and indexes
were validated before promotion.

The validated imported database was promoted to the live gpulink database.

The previous AWS staging database was retained as:

    gpulink_staging_pre_phase4e_20261006

It remains a rollback/debugging asset and is not the production source of
truth.

## Post-promotion recovery checkpoint

A fresh pgBackRest backup succeeded after database promotion.

Accepted backup label:

    20261004-021327F_20261006-231907I

PostgreSQL remained healthy and the AWS control plane remained frozen while
the database was promoted and checkpointed.

## Production writer activation

The AWS control plane was scaled from zero to two replicas.

Acceptance confirmed:

    desired replicas:    2
    updated replicas:    2
    ready replicas:      2
    available replicas:  2

Before worker reconnection:

    workers:             3
    jobs:                20
    active jobs:         0
    events:              316
    max event sequence:  316

Public readiness returned:

    {"status":"ready"}

No worker identity changed during control-plane activation.

## JPCMAIN reconnection

JPCMAIN was deliberately parked during control-plane activation and then
reconnected independently.

Worker identity:

    worker_919b0b1b6c744e6bb5936ba2ada127c7

Worker name:

    jpcmain-3090ti

GPU:

    NVIDIA GeForce RTX 3090 Ti
    GPU-326a4232-3d30-423b-29a1-66f2d054a0d4

Reconnection preserved the restored worker identity and did not create a
duplicate worker row.

The durable event sequence advanced from the restored production sequence
without collision.

## Final production GPU workload

Final Phase 4E production acceptance job:

    job_3b62a2d5b2cf42598e26e320fce699ba

Project:

    phase4e-production-acceptance

Workload:

    benchmark.gpu

Lifecycle:

    leased -> running -> succeeded

The job succeeded on attempt 1.

Assigned worker:

    worker_919b0b1b6c744e6bb5936ba2ada127c7

Execution result:

    GPU:                NVIDIA GeForce RTX 3090 Ti
    GPU UUID:           GPU-326a4232-3d30-423b-29a1-66f2d054a0d4
    backend:            pytorch-cuda
    backend version:    2.12.1+cu130
    CUDA runtime:       13.0
    matrix size:        1024
    warmup iterations:  1
    measured iterations: 1
    duration:           2710 ms

This small workload was intentionally used instead of repeating the previously
accepted Phase 4D benchmark and soak suites.

## Final authoritative state

After the accepted production workload:

    workers:             3
    jobs:                21
    active jobs:         0
    events:              327
    max event sequence:  327

JPCMAIN remained online and not drained.

The AWS control plane remained healthy with two Ready replicas.

The public AWS production endpoint remained Ready.

## Accepted production path

The accepted production execution path is:

    public HTTPS
        -> AWS Traefik
        -> two-replica GPULink control plane
        -> authoritative PostgreSQL
        -> distributed scheduler
        -> outbound physical GPU worker
        -> physical CUDA execution
        -> durable result and lifecycle events

AWS hosts the control-plane and persistence tier.

The accepted GPU remains a physical GPULink worker outside AWS.

## Rollback boundary

The rollback window remains open until an explicit operator decision closes it.

During the rollback window:

- AWS remains authoritative production.
- The DigitalOcean control plane remains stopped.
- DigitalOcean state is retained only for rollback.
- The previous AWS staging database remains preserved.
- Accepted AWS PostgreSQL backups remain available.
- No competing DigitalOcean writer may be started.
- DigitalOcean retirement is a separate destructive operation.

## Phase transition

Phase 4 production acceptance is complete.

The next project phase is Phase 5, the GPULink application platform.

The immediate direction is to add generic persistent-session and real-time
data-plane primitives so applications such as CaptionLink can request
speech.streaming without embedding CaptionLink-specific behavior in GPULink
Core.
