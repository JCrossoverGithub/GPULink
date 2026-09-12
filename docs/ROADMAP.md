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

Off-host backup and point-in-time recovery are Phase 4 responsibilities.

## Phase 4 — AWS + K3s platform

**Status: next**

Phase 4 moves the production control plane to infrastructure designed for the
next stage of GPULink.

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

The goal is not to maximize AWS complexity. The goal is to establish a clean,
reproducible platform that can later scale without changing GPULink's core
application contracts.

### Phase 4A — AWS infrastructure foundation

Planned:

- infrastructure-as-code repository structure;
- AWS account/IAM baseline;
- VPC and networking;
- security groups;
- Ubuntu 24.04 EC2 host;
- SSM access;
- dedicated gp3 PostgreSQL EBS volume;
- ECR repositories;
- S3 backup bucket;
- encryption, versioning, and lifecycle policy;
- EC2 IAM role and least-privilege policies;
- reproducible host bootstrap.

No production cutover occurs in this sub-phase.

### Phase 4B — K3s platform

Planned:

- pinned K3s installation;
- namespace design;
- Kubernetes Secrets and ConfigMaps;
- storage classes and persistent volumes;
- PostgreSQL StatefulSet;
- control-plane Deployment and Service;
- readiness/liveness probes;
- resource requests and limits;
- Traefik ingress and TLS;
- ECR image workflow;
- Kubernetes-native deployment and rollback;
- multi-replica scheduler-lock verification;
- cross-replica SSE/event verification.

### Phase 4C — Off-host recovery

Planned:

- pgBackRest;
- full backups to S3;
- WAL archiving;
- backup retention;
- clean restore rehearsal;
- point-in-time recovery rehearsal;
- measured recovery-point objective;
- measured recovery-time objective;
- disaster-recovery runbook;
- proof that loss of the EC2 host does not destroy the backup chain.

### Phase 4D — AWS staging acceptance

Planned:

- non-production GPULink deployment;
- physical-worker enrollment;
- diagnostic workload;
- GPU benchmark workload;
- heterogeneous scheduling;
- drain/recovery testing;
- scheduler concurrency testing;
- SSE/event testing;
- backup and restore testing;
- rollback testing;
- sustained soak testing.

### Phase 4E — Production migration

Planned:

- final DigitalOcean backup;
- controlled write freeze;
- final PostgreSQL state capture;
- database transfer and restore;
- state-count verification;
- AWS control-plane activation;
- physical-worker reconnection;
- real workload acceptance;
- public traffic/DNS cutover;
- rollback window;
- AWS production acceptance;
- DigitalOcean retirement only after acceptance.

## Phase 5 — Workload and platform expansion

**Status: future**

This phase grows GPULink beyond the infrastructure migration.

Candidate work includes:

- embedding workload adapters;
- automatic speech recognition / TransGo integration;
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
