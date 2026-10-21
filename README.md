# GPULink

GPULink is a distributed GPU compute platform for turning otherwise-idle
computers into a shared pool of useful compute.

It started with a simple problem: I had multiple computers with capable GPUs,
but I could only actively use one machine at a time. Most of that GPU capacity
spent its time sitting idle.

That became especially frustrating while working with local AI models. VRAM
was often the limiting resource in the quality of the models I could run, while
other GPU-capable machines were doing nothing. Independent work such as
embeddings, speech recognition, preprocessing, benchmarks, or other inference
tasks could consume resources on my primary machine that I would rather
dedicate to the main model.

GPULink turns those machines into a compute fabric.

Applications submit supported workloads to a central control plane. GPULink
tracks available workers and their GPUs, chooses an appropriate device, leases
the work to it, and records the result. The application using GPULink does not
need to run on the machine containing the GPU — or even on a machine that has a
GPU at all.

That creates two useful capabilities:

- local AI workflows can move independent GPU work away from the GPU whose VRAM
  is needed for a larger primary model;
- other software can treat GPU compute as infrastructure instead of requiring
  every end-user device to own a compatible accelerator.

For example, a future CaptionLink integration could run its user interface on a
lightweight device such as a Chromebook while GPULink supplies GPU compute for
an ASR model running on another machine.

> **GPU compute should be a capability an application requests, not a piece of
> hardware the application has to own.**

GPULink began as a way to make better use of hardware I already owned. It has
grown into a practical distributed-systems project covering heterogeneous GPU
scheduling, durable state, concurrency, failure recovery, safe deployment,
backup and restore verification, and eventually Kubernetes and cloud
infrastructure.

## Current status

**Developer-platform acceptance (October 20, 2026):** GPULink has a
source-built, independently installable CLI preview with a managed local
control plane, an explicitly opted-in GPU worker, and a repository-owned,
real-hardware diagnostic acceptance gate. The installed Linux/WSL workflow
passed against a physical GPU, including authoritative scheduling, durable
SQLite job completion, verified shutdown, and restart. See
[installed GPU diagnostic acceptance](docs/INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md).

**Historical distributed-environment acceptance (October 13, 2026):** the
AWS/K3s + PostgreSQL deployment completed its Phase 4E migration and
production workload gate. This is dated acceptance evidence, **not** a claim
that a live deployment was just rechecked, a turnkey multi-host installer,
or a generally available GPU service. See
[Phase 4E evidence](docs/security/aws-phase4e-production-acceptance-2026-10-13.md).

**Application and SDK evidence:** jobs, streaming sessions, and the
client/adapter contracts are implemented. The .NET Client SDK has a
published **preview**; the TypeScript Client SDK and Adapter SDK are still
private, pre-v1 tooling. An operator-trusted CaptionLink Multitalker
integration was accepted across two machines on October 20, 2026; that
is not independently reproducible operator onboarding or an untrusted-code
sandbox. See [getting started](docs/GETTING_STARTED.md).

For feature-by-feature evidence and publication/deployment limitations, see
[Capability Status](docs/CAPABILITY_STATUS.md). Historical development
checkpoints remain in the [milestone record](docs/developer-platform/verified-milestone-status.md)
and [Roadmap](docs/ROADMAP.md); they are not current release instructions.

## Start developing with GPULink

GPULink is **self-hostable open-source infrastructure**, not a public cluster operated by this project. You can deploy your own control plane and GPU workers, or connect to another operator's GPULink deployment with their authorization. See the [getting-started guide](docs/GETTING_STARTED.md) for application developers, adapter authors, and GPU operators; it distinguishes published SDKs, experimental tooling, and operator responsibilities.

## What GPULink does

### Reuse idle GPU capacity

A machine running a large local model can offload independent GPU work to
another GPULink worker. That does not combine several GPUs into one shared VRAM
address space; instead, it moves separate workloads away from the GPU whose
resources are most valuable.

This is useful for workloads such as:

- embeddings;
- automatic speech recognition;
- preprocessing;
- GPU benchmarks;
- independent inference jobs;
- future workload adapters.

### Give GPU compute to devices that do not have a GPU

A client submits a supported workload through the GPULink API. The scheduler
chooses an eligible GPU worker and the worker executes the allowlisted workload.

The client therefore does not need to know which physical computer owns the GPU.

A laptop, Chromebook, server, web application, or another product can request
GPU compute through the same platform.

## What GPULink is not

GPULink does **not** currently:

- merge several GPUs into one logical pool of shared VRAM;
- accept arbitrary shell commands;
- execute arbitrary uploaded Python;
- execute arbitrary user-provided containers;
- expose worker machines directly to inbound Internet traffic;
- act as a general-purpose Kubernetes cluster;
- automatically provision commercial cloud GPUs.

Workloads are explicit, versioned, validated capabilities.

## GPULink as an application framework

GPULink Core is the GPU orchestration layer, not a single end-user application.

It provides reusable infrastructure for:

- GPU worker discovery and inventory;
- capability-aware scheduling;
- leases and resource ownership;
- adapter and model readiness;
- authentication;
- durable lifecycle state;
- retries and worker recovery;
- batch execution;
- persistent real-time sessions and authenticated relay transport.

Applications consume those primitives while keeping their own product behavior
outside the scheduler.

CaptionLink is the first operator-trusted real-time integration. Its
Multitalker inference was accepted across a separate client machine and GPU
worker on October 20, 2026. Audio capture, rendering, and accessibility UX
remain CaptionLink responsibilities; a turnkey integration installer is
not yet claimed.

Future reference applications may demonstrate other uses of the same framework,
including batch scheduling, secure remote inference access, organizational fleet
management, and external capacity sharing. Those applications are not current
GPULink Core features.

See [Application Framework](docs/APPLICATION_FRAMEWORK.md) for the architectural
boundary and execution model.

## Current architecture

The dated October 13, 2026 production acceptance used AWS/K3s for the
authoritative control-plane and persistence tier. The following diagram is
that accepted deployment topology, not a universal installation recipe or
a current live-environment health assertion.

The former DigitalOcean deployment is frozen and retained only as a rollback
target. Its control plane remains stopped while AWS is authoritative.

The physical GPU workers remain outside AWS and initiate outbound HTTPS
connections to the public AWS control plane.

```mermaid
flowchart TD
    Client["Application / Product / CLI"]

    subgraph DO["Frozen rollback target — DigitalOcean"]
        Nginx["Nginx + TLS — rollback only"]
        DOControl["GPULink Control Plane — stopped"]
        DOPostgres[("PostgreSQL 17 — frozen state")]
    end

    subgraph AWS["Authoritative production — AWS/K3s"]
        Traefik["Traefik + HTTPS"]
        AWSControl["GPULink Control Plane"]
        AWSPostgres[("PostgreSQL 17 on gp3")]
        Recovery["pgBackRest"]
        S3["Off-host S3 backup + WAL"]
    end

    subgraph Fleet["Outbound-only physical GPU workers"]
        GPU1["MAINPC\nRTX 3070 Ti 8 GB"]
        GPU2["JPCMAIN\nRTX 3090 Ti 24 GB"]
        GPU3["Laptop\nRTX 4060 8 GB"]
    end

    Client -->|"production HTTPS"| Traefik

    Nginx --> DOControl
    DOControl --> DOPostgres
    Traefik --> AWSControl
    AWSControl --> AWSPostgres
    AWSPostgres --> Recovery
    Recovery --> S3

    GPU1 -->|"outbound HTTPS"| Traefik
    GPU2 -->|"outbound HTTPS"| Traefik
    GPU3 -->|"outbound HTTPS"| Traefik
```

PostgreSQL in AWS remains internal. pgBackRest provides off-host S3 backup and
continuous WAL archival, while cert-manager owns steady-state public certificate
management.

Workers initiate outbound connections, so GPULink does not require inbound
worker ports on personal GPU computers.

Phase 4E proved the post-migration production path through the public AWS
endpoint and executed real CUDA on JPCMAIN's physical RTX 3090 Ti while
preserving its migrated worker identity.

The DigitalOcean components shown above are not live production writers. They
are retained only for rollback until an explicit retirement decision.

See [Architecture](docs/ARCHITECTURE.md) for the detailed design.

## Scheduling

Workers report validated GPU inventories and supported capabilities.

The scheduler considers factors including:

- required capability;
- minimum VRAM;
- worker health;
- drain state;
- active GPU assignment;
- warm-model locality;
- verified cached-model locality;
- utilization and available headroom.

A physical GPU receives at most one active GPULink job at a time.

Scheduler decisions occur inside database transactions. PostgreSQL advisory
locking prevents multiple control-plane replicas from independently scheduling
the same work.

## Persistence and events

PostgreSQL is the authoritative production store for:

- workers;
- jobs;
- leases;
- scheduler state;
- durable operational events.

SQLite remains in the repository for focused tests and migration fixtures. It
is no longer the production source of truth.

Event notifications are commit-aware. PostgreSQL uses `LISTEN` / `NOTIFY` to
wake subscribers across persistence instances, while the durable event record
remains in PostgreSQL.

## Workload security

GPULink uses scoped credentials for clients, workers, and administrators.

Workers execute only allowlisted workload implementations. Runtime input is
validated and bounded before execution.

The durable scheduler is intended for workload control, assignment, metadata,
and results. High-rate streaming payloads such as live audio should use a
workload-specific data path rather than being written packet-by-packet through
the durable job scheduler.

## Production safety

The current deployment includes:

- immutable Git-derived control-plane image tags;
- OCI source, revision, and version labels;
- installed and deployed revision tracking;
- a shared deploy/rollback exclusion lock;
- active-job checks before rollback;
- a verified PostgreSQL backup before rollback;
- refusal to roll back to legacy/untraceable releases;
- no-build rollback to retained immutable images;
- bounded traceable-release retention;
- `/healthz` and `/readyz` acceptance checks.

A real production rollback and forward restore have both been exercised while
leaving the PostgreSQL container and durable state unchanged.

See [Production Operations](docs/PRODUCTION_OPERATIONS.md).

## Backup and recovery

The October 13, 2026 Phase 4E acceptance migrated authoritative production
state from DigitalOcean to AWS/K3s. DigitalOcean remained a **stopped,
frozen rollback target**; it is not the current production writer in that
accepted deployment. See the
[Phase 4E migration evidence](docs/security/aws-phase4e-production-acceptance-2026-10-13.md).

AWS reference-environment recovery acceptance includes pgBackRest full and
incremental backups, off-host S3 WAL archival, isolated restore rehearsal,
and named point-in-time recovery. These are historical acceptance results,
not a guaranteed recovery-time objective or an assertion of present-day
operational health. See the
[Phase 4 AWS Foundation](docs/PHASE4_AWS_FOUNDATION.md) and
[operator recovery runbook](docs/security/aws-postgres-disaster-recovery-runbook.md).

## Operations console

The repository also contains a read-only
[operations console](dashboard/README.md) with an Angular frontend and loopback
Flask gateway. It visualizes fleet and scheduler state without putting
administrator or client credentials in browser JavaScript.

## Requirements

### Control plane / development

- Node.js 24 or newer
- PostgreSQL 17 for PostgreSQL integration tests and production persistence
- Docker Engine
- Docker Compose v2
- Ubuntu 24.04 for the current production host

### GPU workers

- Windows 11 with WSL2 and systemd for the current personal-computer workers
- Node.js 24 or newer inside WSL
- NVIDIA drivers with a working `nvidia-smi` inside WSL
- Python 3.10 through 3.14 for the optional isolated benchmark runtime

### Operations console

- Python 3.12 or newer for the optional Flask gateway
- Node/Angular tooling for the dashboard frontend

## Local verification

Install dependencies:

```bash
npm ci
```

The complete repository check is:

```bash
npm run check
```

PostgreSQL integration tests use:

```bash
export GPULINK_TEST_POSTGRES_URL='postgresql://gpulink:gpulink-dev-only@127.0.0.1:5432/gpulink'
npm run check
```

The repository test count changes as work is added. Hardware acceptance is
separately and explicitly opted in; see
[Installed Local GPU Diagnostic Acceptance](docs/INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md).

## Command-line operations

Configure the public URL and the credential appropriate to the operation:

```bash
export GPULINK_URL=https://gpulink.example.invalid  # replace with your authorized deployment
export GPULINK_CLIENT_TOKEN=replace-me
export GPULINK_ADMIN_TOKEN=replace-me
```

Examples:

```bash
npm run cli -- workers
npm run cli -- submit-diagnostic 256
npm run cli -- submit-benchmark 4096 3 10
npm run cli -- wait <job-id>
npm run cli -- drain <worker-id>
npm run cli -- resume <worker-id>
```

Never commit real credentials to the repository.

## Deployment

The current production deployment and recovery procedures are documented in
[Production Operations](docs/PRODUCTION_OPERATIONS.md).

The original
[First Operational Target](docs/FIRST_OPERATIONAL_TARGET.md) is retained as
historical documentation for the first physical-fleet acceptance milestone. It
should not be treated as the current production architecture.

## Roadmap

The current architecture rework is organized into major phases:

- **Phase 0 — physical GPU acceptance:** complete
- **Phase 1 — PostgreSQL persistence:** complete
- **Phase 2 — distributed scheduler/event correctness:** complete
- **Phase 3 — production hardening and recovery:** complete
- **Phase 4 — AWS + K3s production GPU fabric:** historically accepted in production on 2026-10-13
- **Phase 5 — application platform:** jobs/sessions/transport and preview SDKs implemented; stable publication and general adoption remain open
- **Phase 6 — reference applications:** CaptionLink two-machine operator-trusted integration accepted; wider reference onboarding remains open
- **Phase 7 — private multi-user GPU fleet:** future
- **Phase 8 — cross-trust distributed GPU network:** long-term future
- **Phase 9 — optional capacity exchange:** long-term concept

See [Roadmap](docs/ROADMAP.md) for details.

## Documentation
- [Current capability and acceptance status](docs/CAPABILITY_STATUS.md)
- [Getting started by role](docs/GETTING_STARTED.md)
- [Installed CLI developer preview](docs/CLI_DISTRIBUTION.md)

- [Architecture](docs/ARCHITECTURE.md)
- [Application Framework](docs/APPLICATION_FRAMEWORK.md)
- [ADR 0002 — Application Framework Boundary](docs/adr/0002-application-framework-boundary.md)
- [API](docs/API.md)
- [Roadmap](docs/ROADMAP.md)
- [Verified Developer-Platform Milestone Status](docs/developer-platform/verified-milestone-status.md)
- [Phase 4 AWS Foundation](docs/PHASE4_AWS_FOUNDATION.md)
- [Production Operations](docs/PRODUCTION_OPERATIONS.md)
- [GPU Benchmark Workload](docs/GPU_BENCHMARK.md)
- [AWS Control-Plane Staging Acceptance](docs/security/aws-control-plane-staging-acceptance.md)
- [AWS GPU Workload Acceptance](docs/security/aws-gpu-workload-acceptance.md)
- [AWS PostgreSQL Disaster-Recovery Runbook](docs/security/aws-postgres-disaster-recovery-runbook.md)
- [Model Cache Inventory](docs/MODEL_CACHE.md)
- [Operations Console](dashboard/README.md)
- [First Operational Target — historical](docs/FIRST_OPERATIONAL_TARGET.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

GPULink is licensed under Apache-2.0.

GPULink does not bundle model weights. Operators are responsible for complying
with the license and usage requirements of every model they install.
