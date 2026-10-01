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

Phases 0 through 3 of the current architecture rework are complete. Phase 4,
the AWS + K3s platform migration, is actively in progress.

The transitional DigitalOcean deployment remains the authoritative production
environment until the Phase 4E production-state migration and rollback window
are accepted.

The AWS/K3s reference environment has now accepted:

- Terraform-managed AWS infrastructure in `us-east-1`;
- a pinned K3s host on Ubuntu 24.04;
- PostgreSQL 17 on dedicated encrypted gp3 storage;
- immutable PostgreSQL and control-plane images distributed through ECR;
- host-side ECR authentication without exposing AWS credentials to Pods;
- pgBackRest mutual TLS;
- continuous WAL archival and off-host PostgreSQL backup storage;
- isolated restore verification and named point-in-time recovery;
- recurring backup and restore-verification automation;
- the PostgreSQL disaster-recovery runbook;
- a single-replica GPULink control plane backed by AWS PostgreSQL;
- public Traefik HTTP-to-HTTPS ingress;
- trusted public TLS and cert-manager certificate management;
- physical JPCMAIN worker registration through the public AWS control plane;
- a real `benchmark.gpu` CUDA workload executed on the physical RTX 3090 Ti;
- persisted benchmark results and durable queue, lease, start, and success
  events.

The physical GPU fleet remains:

- MAINPC — RTX 3070 Ti 8 GB;
- JPCMAIN — RTX 3090 Ti 24 GB;
- laptop — RTX 4060 8 GB.

AWS staging currently proves the complete JPCMAIN RTX 3090 Ti path. Remaining
Phase 4D work expands that acceptance across the RTX 3070 Ti and RTX 4060,
heterogeneous scheduling, drain/recovery behavior, multi-replica scheduler and
event correctness, application rollback, and sustained operation.

See [Roadmap](docs/ROADMAP.md) for the current project plan.

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

## Current architecture

GPULink currently has two intentionally distinct infrastructure roles:

1. the transitional DigitalOcean deployment remains the authoritative
   production environment until Phase 4E migration acceptance;
2. the AWS/K3s reference environment is the active Phase 4 staging platform and
   has independently passed infrastructure, recovery, public-ingress,
   single-replica control-plane, and first-GPU-workload acceptance.

```mermaid
flowchart TD
    Client["Application / Product / CLI"]

    subgraph DO["Authoritative production — transitional DigitalOcean"]
        Nginx["Nginx + TLS"]
        DOControl["GPULink Control Plane"]
        DOPostgres[("PostgreSQL 17")]
    end

    subgraph AWS["AWS/K3s reference environment — Phase 4 staging"]
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

    Client -->|"production HTTPS"| Nginx
    Nginx --> DOControl
    DOControl --> DOPostgres

    Client -.->|"AWS staging HTTPS"| Traefik
    Traefik --> AWSControl
    AWSControl --> AWSPostgres
    AWSPostgres --> Recovery
    Recovery --> S3

    GPU1 -->|"outbound HTTPS"| Nginx
    GPU2 -->|"outbound HTTPS"| Nginx
    GPU3 -->|"outbound HTTPS"| Nginx

    GPU2 -.->|"accepted AWS workload path"| Traefik
```

The DigitalOcean control plane remains loopback-published behind its HTTPS
reverse proxy and PostgreSQL has no public host port.

The AWS reference environment runs the control plane and PostgreSQL inside K3s.
Traefik provides the accepted public HTTPS boundary while PostgreSQL remains
internal. Deployment-specific TLS material stays outside the public repository;
cert-manager owns steady-state public-certificate renewal.

Workers initiate outbound connections, so GPULink does not require inbound
worker ports on personal GPU computers. JPCMAIN has completed this path through
the public AWS control plane and executed a real CUDA workload on its RTX 3090
Ti.

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

The transitional DigitalOcean production deployment continues to create
verified PostgreSQL custom-format backups with checksums, structural validation,
database-state metadata, and automated disposable restore verification.

Those DigitalOcean backups remain on the same host as the authoritative
production database. That limitation remains until production state is migrated
to AWS.

The AWS/K3s reference environment has independently accepted the Phase 4
off-host recovery path:

- pgBackRest full and incremental backups;
- S3-backed off-host backup storage;
- continuous WAL archival;
- a 60-second PostgreSQL `archive_timeout` for low-write WAL switching;
- named point-in-time recovery;
- isolated restore rehearsals that do not mount the production PostgreSQL PVC;
- recurring host-side backup automation;
- Kubernetes restore-verification automation;
- an operator disaster-recovery runbook.

This proves that the AWS recovery chain is not dependent on the EC2 database
volume alone. It does not mean that the DigitalOcean production database has
already been migrated or retired.

See [Phase 4 AWS Foundation](docs/PHASE4_AWS_FOUNDATION.md) and the recovery
acceptance records under `docs/security/`.

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

The Phase 3 production baseline passed all 88 tests.

## Command-line operations

Configure the public URL and the credential appropriate to the operation:

```bash
export GPULINK_URL=https://gpulink.schultzsystems.com
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
- **Phase 4 — AWS + K3s platform migration:** in progress
- **Phase 5 — workload/platform expansion:** future

See [Roadmap](docs/ROADMAP.md) for details.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Roadmap](docs/ROADMAP.md)
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
