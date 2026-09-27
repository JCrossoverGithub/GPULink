# Phase 4 — AWS Infrastructure Foundation

## Status

Phase 4 remains the active infrastructure milestone.

Phases 0 through 3 established and production-tested the GPULink application,
PostgreSQL persistence layer, distributed scheduling semantics, release
management, rollback, backup, and restore-verification behavior.

Phase 4 moves those guarantees from the transitional DigitalOcean Docker
deployment onto a reproducible AWS/K3s platform.

Accepted through 2026-09-27 are the AWS infrastructure foundation, K3s host
foundation, PostgreSQL 17 runtime, protected persistent storage, host-side ECR
authentication, workload isolation from EC2 metadata, pgBackRest mutual TLS,
continuous WAL archival, a full off-host backup, isolated restore and named
point-in-time recovery, and measured low-write off-host WAL recoverability.

Phase 4 is not yet complete. Application/control-plane staging, remaining
recovery automation and runbook work, worker/workload acceptance, public
cutover, and rollback-window completion remain open.

No production cutover should occur until the AWS environment has independently
passed staging, recovery, worker, workload, and rollback acceptance.

## Goals

Phase 4 should provide:

- reproducible infrastructure as code;
- a small AWS footprint appropriate to the current GPULink workload;
- Kubernetes-native application deployment through K3s;
- persistent PostgreSQL storage on dedicated EBS;
- off-host PostgreSQL backup and WAL storage in S3;
- administrative access through AWS Systems Manager;
- immutable application images through ECR;
- a staging environment that can be proven before production migration;
- a documented recovery path if the compute host is lost.

The initial architecture intentionally favors simplicity over enterprise-scale
AWS complexity.

## Non-goals

The first AWS deployment does not require:

- EKS;
- RDS;
- an Application Load Balancer;
- a NAT Gateway;
- multi-AZ Kubernetes;
- multi-node K3s;
- high-availability PostgreSQL;
- automatic commercial cloud GPU provisioning;
- autoscaling infrastructure.

These can be introduced later if actual usage justifies the added cost and
operational complexity.

## Region

Initial AWS region:

- `us-east-1`

The first deployment should remain in one region.

## High-level topology

Applications and personal GPU workers communicate with the public GPULink
control plane over HTTPS.

The accepted AWS environment contains one Ubuntu 24.04 EC2 instance running
K3s.

The currently proven K3s application workload in this Phase 4 record is
PostgreSQL 17 with its pgBackRest integration.

The Phase 4 target also places Traefik and the GPULink control plane on K3s.
Those application-layer components are not claimed as accepted by the recovery
milestones documented here.

PostgreSQL data lives on a dedicated gp3 EBS volume rather than the EC2 root
filesystem.

AWS supporting services provide:

- ECR for GPULink container images;
- S3 for PostgreSQL backup and WAL storage;
- Systems Manager for administrative host access.

The existing GPU workers remain outside AWS and connect outbound to the public
control plane.

Current workers include:

- MAINPC — RTX 3070 Ti 8 GB;
- JPCMAIN — RTX 3090 Ti 24 GB;
- laptop — RTX 4060 8 GB.

## Network model

The initial environment should use one VPC.

The first version should avoid unnecessary network layers.

The EC2 host requires outbound Internet access for:

- system packages;
- container/image retrieval;
- AWS service access where required;
- K3s operation.

Public inbound access should be restricted to the traffic necessary to serve
GPULink HTTPS.

Administrative SSH exposure should not be required for normal operation.
Systems Manager should be the primary administrative access path.

PostgreSQL must never be publicly reachable.

Personal GPU workers continue to require only outbound connectivity.

## Compute

The initial platform uses one EC2 Ubuntu 24.04 instance.

The currently accepted instance role hosts:

- K3s;
- PostgreSQL;
- pgBackRest repository services and operational tooling.

Phase 4 application staging will add and validate the GPULink control plane and
ingress responsibilities before cutover.

Instance sizing should be based on the current GPULink workload rather than
selected for theoretical future scale.

The instance must be replaceable from infrastructure-as-code plus persistent
data and recovery artifacts.

## Storage

The EC2 root volume should contain only replaceable operating-system and
platform state.

PostgreSQL data should use a dedicated gp3 EBS volume.

The database volume should:

- be encrypted;
- have an explicit lifecycle policy;
- be mounted independently from the root filesystem;
- survive normal application/container replacement;
- be clearly identifiable as authoritative persistent storage.

K3s persistent-volume configuration should bind PostgreSQL to this storage
without coupling database durability to a container filesystem.

## PostgreSQL

PostgreSQL 17 remains the authoritative GPULink persistence backend.

The Kubernetes migration must preserve the application-level guarantees already
proved in production:

- transactional scheduler decisions;
- PostgreSQL advisory scheduler locking;
- durable events;
- commit-aware notification;
- worker and job recovery behavior;
- migration history;
- graceful control-plane shutdown.

PostgreSQL should initially remain single-instance.

High availability is not required until the service requirements justify its
operational cost.

## Container images

Production application images should be stored in Amazon ECR.

Image identity must remain traceable to Git revisions.

The existing release principles should continue:

- immutable release identity;
- source revision metadata;
- no mutable production release assumptions;
- deterministic rollback targets.

The Kubernetes deployment should reference immutable image identities rather
than relying on a moving `latest` tag.

## Administrative access

AWS Systems Manager should be the default administrative access mechanism for
the EC2 host.

The design should avoid requiring a permanently exposed SSH port.

IAM permissions should follow least privilege.

Human administrative access and EC2 workload permissions should be separate
trust boundaries.

## Backup and disaster recovery

The current DigitalOcean deployment proves that PostgreSQL backups can be
created and restored, but those backups live on the same host.

Phase 4 moves database recovery artifacts off-host.

The target recovery system is:

- pgBackRest;
- full PostgreSQL backups to S3;
- WAL archiving to S3;
- retention policies;
- encrypted storage;
- automated verification;
- clean restore rehearsal;
- point-in-time recovery rehearsal.

Loss of the EC2 instance must not destroy the authoritative backup chain.

## Kubernetes

The first orchestration platform is K3s rather than EKS.

K3s should host:

- Traefik ingress;
- GPULink control-plane Deployment;
- PostgreSQL StatefulSet;
- Services;
- Secrets;
- ConfigMaps;
- persistent storage definitions.

The Kubernetes design must preserve scheduler correctness when more than one
control-plane pod exists.

The PostgreSQL advisory lock remains the cross-replica scheduler ownership
mechanism.

SSE and PostgreSQL notification behavior must also be verified across multiple
control-plane replicas before that topology is considered accepted.

## Infrastructure as code

AWS infrastructure should be defined declaratively.

The initial implementation will use Terraform and HCL to define AWS
infrastructure declaratively.

Terraform infrastructure code should live under `infra/`.

The repository should separate:

- reusable infrastructure components;
- environment-specific configuration;
- Kubernetes manifests or Helm configuration;
- bootstrap logic;
- operational documentation.

Secrets must not be committed into infrastructure state configuration or source
files.

## Planned repository structure

Initial direction:

    infra/
      README.md
      aws/
        environments/
          production/
        modules/
      kubernetes/
        base/
        production/

The exact structure may evolve as the first resources are implemented.

## Phase 4A acceptance criteria

Phase 4A is complete when:

- infrastructure-as-code initializes successfully;
- the AWS account/region/provider boundary is defined;
- VPC networking exists;
- EC2 exists and can be administered through Systems Manager;
- the dedicated encrypted gp3 PostgreSQL volume exists and is attached;
- ECR repositories exist;
- the S3 recovery bucket exists with appropriate protection;
- required IAM roles and policies exist;
- the host can be rebuilt reproducibly;
- no production GPULink traffic has been cut over yet.

## Phase 4B — K3s platform

After Phase 4A:

- install and pin K3s;
- configure namespaces;
- configure storage;
- deploy PostgreSQL;
- deploy the GPULink control plane;
- configure Traefik and TLS;
- validate health/readiness;
- validate image deployment through ECR;
- validate scheduler and event behavior across replicas.

## Phase 4C — Recovery

Recovery acceptance through 2026-09-27:

- pgBackRest 2.59.1 is present on both database and repository sides;
- database/repository protocol traffic is mutually authenticated with TLS;
- cloud credentials remain outside Kubernetes workloads;
- continuous PostgreSQL WAL archival reaches the off-host repository;
- PostgreSQL reported zero archive failures during acceptance;
- a full PostgreSQL backup completed successfully;
- that backup was restored into fresh disposable storage through the repository
  service while the production PostgreSQL Pod remained online;
- the restored PostgreSQL 17 cluster reached a consistent state, promoted, and
  returned the expected persistence probe data;
- the restored validation instance used no production PVC, no Kubernetes
  Service, no TCP listener, and archive mode remained disabled;
- named point-in-time recovery was exercised against an explicit
  operator-selected restore point in disposable storage;
- the PITR test recovered state committed before the restore point and excluded
  state committed after it, even though both states were represented within the
  same WAL segment;
- the accepted PITR run used only its disposable local pgBackRest repository
  during WAL replay and did not attach or modify the production PostgreSQL
  volume;
- the accepted PITR file-restore phase completed in 4.627 seconds and PostgreSQL
  startup/recovery completed in 0.469 seconds for the small acceptance dataset.
  These measurements are validation evidence, not a production RTO commitment;
- the AWS PostgreSQL runtime now uses `archive_timeout=60s` so low-write WAL
  segments have an explicit time-based switch threshold;
- three production marker-to-off-host archive trials completed in 21.338,
  23.508, and 38.590 seconds with zero archive failures. These are observed
  acceptance measurements, not a production RPO SLA;
- host-side pgBackRest backup automation is installed and the daily systemd
  timer is enabled;
- the automated backup path successfully produced a full backup and an
  incremental backup through the off-host repository;
- Kubernetes restore verification successfully restored the newest incremental
  backup chain into disposable `emptyDir` storage without mounting the
  production PostgreSQL PVC;
- the accepted automated restore completed physical restore in 40.133 seconds
  and PostgreSQL startup/recovery in 2.136 seconds for the current small
  dataset. These measurements are validation evidence, not a production RTO;
- the restore verifier enforces a six-hour maximum backup age in the AWS
  weekly schedule, rejects partial application-schema state, runs PostgreSQL
  without a TCP listener and with archive mode disabled, and explicitly
  removes restored database contents after validation;
- the weekly restore-verification CronJob is active for Sunday 04:00 UTC with
  `concurrencyPolicy=Forbid` and a one-hour starting deadline;
- activation produced no unintended catch-up Job and left production
  PostgreSQL healthy and unchanged. The first naturally scheduled weekly run
  remains future operational evidence.

The first accepted off-host full backup label was:

    20260926-235429F

Detailed recovery evidence is recorded in:

- `docs/security/aws-postgres-pitr-recovery-acceptance.md`;
- `docs/security/aws-postgres-rpo-acceptance.md`;
- `docs/security/aws-postgres-recurring-recovery-acceptance.md`.

Remaining Phase 4C work:

- complete the operator disaster-recovery runbook.

## Phase 4D — Staging acceptance

The AWS stack must prove:

- real worker registration;
- RTX 3070 Ti connectivity;
- RTX 3090 Ti connectivity;
- RTX 4060 connectivity;
- diagnostic workloads;
- GPU benchmark workloads;
- heterogeneous scheduling;
- drain/resume;
- stale-worker recovery;
- scheduler concurrency;
- SSE delivery;
- backup;
- restore;
- rollback;
- sustained operation.

## Phase 4E — Production migration

Only after staging acceptance:

- take a final DigitalOcean backup;
- freeze authoritative writes;
- capture the final PostgreSQL state;
- restore that state into AWS;
- verify workers, jobs, events, and migration history;
- bring the AWS control plane online;
- reconnect physical workers;
- run real workload acceptance;
- move public traffic;
- retain a rollback window;
- retire DigitalOcean only after AWS production acceptance.

## Design principle

Phase 4 should not recreate the DigitalOcean Docker Compose deployment line for
line inside Kubernetes.

The objective is to preserve GPULink's proven operational guarantees while
using infrastructure-native mechanisms appropriate to AWS and Kubernetes.

Keep the initial platform small, understandable, recoverable, and
reproducible.
