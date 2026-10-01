# GPULink Roadmap

This roadmap describes the current engineering sequence for GPULink.

GPULink began as a way to reuse otherwise-idle GPUs across several personal
computers. The longer-term goal is a reusable compute layer that allows
applications to request supported GPU capabilities without needing to own,
locate, or directly manage the physical accelerator.

The roadmap is intentionally incremental. Each phase establishes operational
guarantees that the next phase depends on.

## Phase 0 — Physical GPU acceptance

**Status: complete**

Goal: prove that GPULink works on real heterogeneous personal-computer GPUs,
not only test fixtures.

Completed:

- public HTTPS control plane;
- outbound-only WSL workers;
- RTX 3070 Ti desktop acceptance;
- RTX 3090 Ti workstation acceptance;
- RTX 4060 laptop acceptance;
- NVIDIA inventory and telemetry;
- worker registration and heartbeat;
- drain and resume;
- capability and minimum-VRAM scheduling;
- exclusive one-job-per-GPU assignment;
- lease/start/renew/finish lifecycle;
- stale-worker recovery;
- bounded retry behavior;
- diagnostic workload;
- real CUDA benchmark workload;
- physical-fleet acceptance evidence.

## Phase 1 — PostgreSQL persistence

**Status: complete**

Goal: replace the single-process SQLite production boundary with persistence
suitable for multiple control-plane processes and future Kubernetes deployment.

Completed:

- Promise-based persistence contract;
- asynchronous control-plane persistence;
- SQLite adapter retained for tests and migration fixtures;
- PostgreSQL schema and migrations;
- worker persistence;
- job persistence;
- event persistence;
- job lease lifecycle;
- recovery semantics;
- counts and operational queries;
- same-client PostgreSQL transactions;
- PostgreSQL HTTP integration coverage;
- configurable persistence backend;
- SQLite-to-PostgreSQL migration utility;
- production migration;
- PostgreSQL made authoritative in production.

## Phase 2 — Distributed scheduler and event correctness

**Status: complete**

Goal: preserve scheduling and event-delivery correctness when more than one
control-plane process can exist.

Completed:

- coalescing scheduler runner;
- no overlapping scheduler passes;
- graceful shutdown that waits for scheduler work;
- PostgreSQL advisory scheduler locking;
- cross-replica scheduler exclusion;
- commit-aware event notifications;
- PostgreSQL `LISTEN` / `NOTIFY`;
- SQLite post-commit notification behavior;
- SSE wake-up from scheduler-generated events;
- SSE wake-up from events written by another persistence instance;
- regression and concurrency coverage.

## Phase 3 — Production hardening and recovery

**Status: complete**

Goal: make the transitional DigitalOcean production deployment traceable,
recoverable, and safe to operate.

Completed:

- PostgreSQL-first production installation;
- protected credential preservation;
- loopback-only control-plane publication;
- no host-published PostgreSQL port;
- immutable Git-derived release images;
- OCI release metadata;
- exact archive/revision verification;
- installed/deployed revision tracking;
- shared deployment/rollback lock;
- active-job rollback gate;
- pre-rollback database backup;
- refusal of legacy/untraceable rollback targets;
- no-build rollback to retained immutable images;
- real production rollback rehearsal;
- forward restore rehearsal;
- release retention;
- daily PostgreSQL backup automation;
- backup checksums;
- structural `pg_restore` validation;
- recorded database-state metadata;
- backup retention;
- disposable full restore rehearsal;
- weekly automated restore verification;
- production PostgreSQL isolation checks;
- final-server PostgreSQL readiness handling;
- production health/readiness acceptance.

The Phase 3 baseline completed with the full test suite green.

### Known Phase 3 limitation

Backups are stored on the same DigitalOcean host as the production database.

They provide a tested logical recovery path but do not provide complete disaster
recovery if the entire host is lost.

Off-host backup and point-in-time recovery were Phase 4 responsibilities.
The AWS Phase 4C reference environment has since accepted that recovery path;
the same-host limitation remains applicable to the transitional DigitalOcean
production deployment until Phase 4E migration.

## Phase 4 — AWS + K3s platform

**Status: in progress**

Accepted through 2026-10-01 are:

- the Terraform-managed AWS infrastructure foundation;
- the K3s host foundation;
- dedicated encrypted PostgreSQL gp3 storage;
- PostgreSQL 17 on K3s;
- immutable ECR image distribution;
- host-side ECR credential isolation;
- S3-backed off-host backup and WAL archival;
- isolated restore verification;
- named point-in-time recovery;
- recurring backup and restore-verification automation;
- the operator disaster-recovery runbook;
- the first single-replica GPULink control-plane deployment on K3s;
- public Traefik HTTP/HTTPS ingress;
- trusted public TLS;
- cert-manager steady-state certificate management;
- the first physical worker registered through the public AWS control plane;
- JPCMAIN RTX 3090 Ti execution of a real `benchmark.gpu` CUDA workload;
- persistence of the result and durable lifecycle events through AWS.

The first accepted AWS GPU workload uses an AWS-hosted **control plane** with a
physical JPCMAIN GPU worker. It is not an AWS-hosted GPU.

Remaining Phase 4 work centers on fleet-wide staging acceptance,
multi-replica behavior, application rollback, sustained operation, and final
authoritative production migration from DigitalOcean.

The initial target deliberately remains small:

- one Ubuntu 24.04 EC2 host in `us-east-1`;
- K3s rather than EKS;
- self-hosted PostgreSQL;
- dedicated gp3 EBS storage for PostgreSQL;
- ECR for application images;
- S3 for off-host database recovery;
- SSM for administrative host access;
- Traefik for ingress;
- outbound-only personal GPU workers.

### Phase 4A — AWS infrastructure foundation

**Status: accepted**

Accepted:

- infrastructure-as-code repository structure;
- AWS account/IAM baseline;
- VPC and networking;
- security groups;
- Ubuntu 24.04 EC2 host;
- Systems Manager administrative access;
- dedicated encrypted gp3 PostgreSQL EBS volume;
- ECR repositories;
- protected S3 recovery bucket;
- EC2 IAM role and least-privilege policies;
- reproducible host bootstrap.

### Phase 4B — K3s platform

**Status: partially accepted**

Accepted:

- pinned K3s installation;
- namespace, Secret, and ConfigMap contracts;
- persistent storage definitions;
- PostgreSQL StatefulSet;
- GPULink control-plane Deployment and Service;
- health/readiness probes;
- immutable ECR image deployment;
- Traefik HTTP/HTTPS ingress;
- public TLS;
- cert-manager steady-state certificate management;
- single-replica control-plane staging.

Remaining:

- Kubernetes-native application rollback acceptance;
- multi-replica scheduler-lock verification;
- cross-replica SSE/event verification.

### Phase 4C — Off-host recovery

**Status: accepted for the staging reference environment**

Accepted:

- pgBackRest;
- full and incremental backups;
- S3-backed off-host storage;
- continuous WAL archiving;
- backup retention controls;
- isolated clean restore rehearsal;
- named point-in-time recovery;
- measured low-write WAL recoverability;
- measured restore timings for the acceptance dataset;
- recurring backup automation;
- recurring restore-verification automation;
- AWS credential isolation from Kubernetes workloads;
- operator disaster-recovery runbook.

Observed timings are acceptance evidence, not production RPO/RTO SLAs.

The first naturally scheduled weekly restore-verification run remains future
operational evidence; the automation path itself has already been accepted.

### Phase 4D — AWS staging acceptance

**Status: in progress**

Accepted through 2026-10-01:

- non-production GPULink control-plane deployment;
- public ingress and trusted TLS;
- cert-manager steady-state certificate management;
- PostgreSQL-backed application persistence;
- physical JPCMAIN worker registration;
- a real `benchmark.gpu` CUDA workload;
- durable queue, lease, start, and success events;
- persisted benchmark result;
- post-run public HTTPS latency sampling;
- workload-evidence provenance and sanitization;
- Phase 4C backup and restore foundations.

Still to prove:

- RTX 3070 Ti connectivity to AWS;
- RTX 4060 connectivity to AWS;
- fleet-wide diagnostic workload coverage;
- GPU benchmark acceptance on the remaining physical GPUs;
- heterogeneous scheduling across multiple eligible workers;
- drain/resume;
- stale-worker recovery;
- scheduler concurrency with multiple control-plane replicas;
- cross-replica SSE/event delivery;
- application rollback;
- sustained soak operation.

### Phase 4E — Production migration

**Status: future**

Only after the remaining staging acceptance:

- take a final DigitalOcean backup;
- freeze authoritative writes;
- capture final PostgreSQL production state;
- transfer and restore that state into AWS;
- verify worker, job, event, and migration-history counts;
- make the restored AWS state authoritative;
- reconnect and verify the physical worker fleet;
- run final real-workload acceptance;
- activate authoritative production traffic on the already-accepted AWS ingress;
- retain a defined rollback window;
- complete AWS production acceptance;
- retire DigitalOcean only after acceptance.

AWS ingress and public TLS are already accepted as staging capabilities. Phase
4E therefore focuses on authoritative state, production traffic, final worker
reconnection, and rollback.

## Phase 5 — Workload and platform expansion

**Status: future**

This phase grows GPULink beyond the infrastructure migration.

Candidate work includes:

- embedding workload adapters;
- automatic speech recognition / CaptionLink integration;
- additional inference adapters;
- stronger model distribution and cache management;
- queue priority and project quotas;
- usage and cost accounting;
- Prometheus/Grafana observability;
- alerting;
- centralized structured logging;
- audit history;
- additional worker platforms;
- optional cloud GPU workers;
- multi-node K3s when actual load justifies it;
- high-availability PostgreSQL only when operational requirements justify the
  added complexity.

## Engineering principle

GPULink should make GPU compute a capability that an application requests,
rather than hardware that every application or end-user device must own.

Infrastructure should remain as simple as possible while preserving the
correctness, recovery, and security guarantees already proven by the system.
