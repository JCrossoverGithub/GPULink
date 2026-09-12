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

For example, a future TransGo integration could run its user interface on a
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

Phases 0 through 3 of the current architecture rework are complete.

The production system currently includes:

- a public HTTPS control plane hosted on DigitalOcean;
- PostgreSQL 17 as the authoritative persistence backend;
- three real outbound-only GPU workers:
  - RTX 3070 Ti desktop;
  - RTX 3090 Ti workstation;
  - RTX 4060 laptop;
- GPU-aware scheduling with exclusive one-job-per-GPU assignment;
- minimum-VRAM and capability constraints;
- worker heartbeat, drain, lease expiry, and bounded retry semantics;
- warm-model and verified model-cache locality;
- scoped client, worker, and administrator credentials;
- durable job, worker, lease, and event state;
- PostgreSQL advisory locking for cross-replica scheduler exclusion;
- commit-aware event notification and server-sent events;
- allowlisted diagnostic and GPU benchmark workloads;
- adapter health and versioned adapter manifests;
- traceable immutable control-plane releases;
- guarded no-build production rollback;
- automated PostgreSQL backups;
- automated weekly restoration of a backup into an isolated PostgreSQL
  instance to prove that the backup is actually recoverable.

The next major phase moves the control plane from the transitional DigitalOcean
Docker Compose deployment to an AWS/K3s platform.

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

```mermaid
flowchart TD
    Client["Application / Product / CLI"]

    subgraph Public["Current control plane — DigitalOcean"]
        Nginx["Nginx + TLS"]
        Control["GPULink Control Plane"]
        Postgres[("PostgreSQL 17")]
    end

    subgraph Fleet["Outbound-only GPU worker pool"]
        GPU1["MAINPC\nRTX 3070 Ti 8 GB"]
        GPU2["JPCMAIN\nRTX 3090 Ti 24 GB"]
        GPU3["Laptop\nRTX 4060 8 GB"]
    end

    Client -->|"HTTPS"| Nginx
    Nginx -->|"127.0.0.1:8088"| Control
    Control --> Postgres

    GPU1 -->|"Outbound HTTPS"| Nginx
    GPU2 -->|"Outbound HTTPS"| Nginx
    GPU3 -->|"Outbound HTTPS"| Nginx
```

Docker publishes the control plane only on `127.0.0.1:8088` on the host.
Nginx terminates public HTTPS and proxies to that loopback listener.

PostgreSQL has no host-published port.

Workers initiate outbound connections to the control plane, so no inbound
GPULink port needs to be opened on a personal GPU computer.

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

The DigitalOcean deployment creates verified PostgreSQL custom-format backups.

Each completed backup includes:

- the PostgreSQL dump;
- SHA-256 checksum;
- `pg_restore --list` structural validation;
- recorded worker, job, event, and job-status counts;
- metadata describing the backup.

A weekly systemd job restores the newest completed backup into an isolated
disposable PostgreSQL 17 container, compares the restored state with the state
recorded at backup time, and removes the disposable resources afterward.

This proves that the backup is restorable.

Current backups are still stored on the same DigitalOcean host. They protect
against logical/database failures, but do **not** provide complete protection
against loss of the entire droplet. Phase 4 adds off-host S3/WAL recovery.

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
- **Phase 4 — AWS + K3s platform migration:** next
- **Phase 5 — workload/platform expansion:** future

See [Roadmap](docs/ROADMAP.md) for details.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Roadmap](docs/ROADMAP.md)
- [Production Operations](docs/PRODUCTION_OPERATIONS.md)
- [GPU Benchmark Workload](docs/GPU_BENCHMARK.md)
- [Model Cache Inventory](docs/MODEL_CACHE.md)
- [Operations Console](dashboard/README.md)
- [First Operational Target — historical](docs/FIRST_OPERATIONAL_TARGET.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

GPULink is licensed under Apache-2.0.

GPULink does not bundle model weights. Operators are responsible for complying
with the license and usage requirements of every model they install.
