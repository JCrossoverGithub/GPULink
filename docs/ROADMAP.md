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

Phase 4D fleet-wide AWS staging acceptance is complete as of 2026-10-05,
including multi-replica behavior, application rollback, and sustained operation.
Remaining Phase 4 work is the Phase 4E authoritative production migration from
DigitalOcean.

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

Subsequently accepted during Phase 4D:

- Kubernetes-native application rollback;
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

**Status: accepted — 2026-10-05**

Accepted:

- non-production AWS/K3s GPULink control-plane deployment;
- public ingress and trusted TLS;
- cert-manager steady-state certificate management;
- PostgreSQL-backed application persistence and Phase 4C recovery foundations;
- RTX 3070 Ti, RTX 3090 Ti, and RTX 4060 connectivity to AWS;
- fleet-wide diagnostic workload coverage;
- real GPU benchmark acceptance across the physical fleet;
- heterogeneous scheduling across eligible workers;
- rejection of ineligible placement;
- drain/resume;
- stale-worker recovery and job reassignment;
- two control-plane replicas in the AWS overlay;
- scheduler concurrency with PostgreSQL advisory-lock exclusion;
- cross-replica SSE/event delivery;
- Kubernetes-native application rollback to a retained immutable image;
- fresh verified pgBackRest backup before rollback;
- no-build rollback and health/readiness validation;
- sustained soak operation with 30/30 first-attempt successes, zero failures,
  three healthy workers, two Ready control-plane replicas, and no additional
  control-plane or PostgreSQL restarts.

See `docs/security/aws-phase4d-staging-acceptance-2026-10-05.md`.

### Phase 4E — Production migration

**Status: next — not started**

Phase 4D staging acceptance is complete. Phase 4E must now:

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

AWS ingress and public TLS are already accepted staging capabilities. Phase 4E
therefore focuses on authoritative state, production traffic, final worker
reconnection, and rollback.

## Phase 5 — Application platform

**Status: future — begins after Phase 4 production acceptance**

Goal: turn the proven GPULink compute fabric into a stable framework that
independent applications can consume without knowing GPULink's deployment
internals.

Phase 5 is the architectural pivot from "a scheduler that can run workloads" to
"a reusable GPU application platform."

Applications should request capabilities and execution semantics. GPULink Core
should remain responsible for placement, ownership, lifecycle, health, and
policy.

The former Phase 5 workload/platform-expansion goals are not discarded. They are
redistributed across the application-platform roadmap:

- additional inference adapters become framework/reference-application work;
- model distribution, cache awareness, and warm-model locality become
  application-platform scheduling capabilities;
- queue priority, project quotas, and organizational policy move into the
  private-fleet phase;
- multi-node K3s remains demand-driven and should be introduced only when
  measured load or availability requirements justify it.

### Phase 5A — Stable application contract

Define the application-facing abstractions that can be used without naming a
specific product.

Core concepts include:

- capabilities;
- workers;
- GPU resources;
- finite jobs;
- persistent sessions;
- adapters;
- model inventory;
- lifecycle events.

Requirements:

- versioned request and response contracts;
- explicit compatibility behavior;
- bounded and validated application metadata;
- capability-oriented resource requests;
- no application-specific object names in generic Core APIs;
- clear distinction between hard requirements and scheduling preferences;
- stable error and lifecycle semantics.

Application code must not require knowledge of PostgreSQL, AWS, K3s, ECR,
scheduler locks, or worker-heartbeat implementation.

Acceptance requires at least two unrelated application shapes to use the same
generic Core abstractions without application names or special-case scheduler
logic.

### Phase 5B — Persistent session lifecycle

Add a first-class execution primitive for interactive or latency-sensitive
workloads.

A target lifecycle is:

```text
requested
    |
    v
allocated
    |
    v
connecting
    |
    v
active
    |
    +------> interrupted
    |            |
    |            +------> replacement allocation
    |
    v
closed
```

Required behavior includes:

- authenticated session requests;
- capability/resource matching;
- explicit allocation ownership;
- lease duration and renewal;
- cancellation and close;
- worker-loss detection;
- bounded replacement/recovery policy;
- durable lifecycle events;
- idempotent client behavior where required;
- drain-aware placement.

The initial safety baseline is **whole-GPU GPULink allocation** unless a worker
explicitly advertises and has acceptance evidence for a stronger sharing
mechanism.

Fractional allocation, time slicing, memory partitioning, or other sharing
mechanisms are future capabilities and must not be inferred merely because
multiple processes can technically use the same GPU.

Acceptance requires session lifecycle correctness under normal completion,
client disconnect, lease expiry, worker loss, drain, and control-plane restart.

### Phase 5C — Real-time data plane

Separate latency-sensitive application traffic from durable scheduler state.

The control plane remains authoritative for:

- authentication;
- placement;
- allocation;
- lease ownership;
- policy;
- lifecycle;
- recovery.

The data plane carries application traffic such as:

- PCM audio;
- video;
- token streams;
- tensors;
- model-server protocol traffic.

PostgreSQL must not become the transport for latency-sensitive or high-volume
application data.

The first implementation may use a relayed data path because it provides a
predictable authentication and NAT boundary:

```text
Application
    |
    v
GPULink gateway
    |
    v
Allocated worker
```

A later direct authorized path may reduce latency and central bandwidth:

```text
Application <=================> Allocated worker
             session-bound
              data plane
```

Direct connectivity is an optimization, not a requirement for the framework to
function.

Acceptance requires measurement of:

- session establishment time;
- transport latency;
- jitter;
- bounded buffering/backpressure;
- interruption behavior;
- reconnect behavior;
- authorization failure behavior.

### Phase 5D — Model-aware and locality-aware scheduling

Extend scheduling beyond raw GPU availability.

The scheduler may consider:

1. required capability;
2. adapter readiness;
3. minimum VRAM;
4. GPU availability;
5. verified model-cache locality;
6. warm-model locality;
7. worker freshness;
8. drain state;
9. project/application policy;
10. future priority and fairness rules.

Model state must distinguish at least:

```text
unavailable
cached
warm
```

Cached means the model can be loaded without fetching it again.

Warm means the required serving state is already resident and can begin useful
work with less startup overhead.

Warmth is a scheduling property, not an application-specific exception.

Acceptance requires deterministic placement tests showing that hard
requirements reject ineligible workers while preferences such as model warmth
influence placement only among otherwise valid candidates.

### Phase 5E — SDK and developer integration surface

Provide an application-facing client layer over stable Core APIs.

Conceptually, applications should be able to perform operations such as:

```text
discover capabilities
submit finite job
observe job
request session
observe allocation
connect to session data plane
renew/observe session
close session
observe lifecycle events
```

The SDK must preserve the control plane's authority and must not bypass lease,
authorization, or scheduling rules.

Initial SDK language and transport decisions remain implementation choices.

Acceptance requires at least one finite-job integration and one persistent-
session integration using the public application contract rather than private
Core internals.

## Phase 6 — Reference applications

**Status: future**

Goal: prove that unrelated products can use GPULink Core without turning the
Core into any one of those products.

Names in this phase are **working descriptions, not committed product names**.
The application boundaries matter more than the labels and may change as the
implementations mature.

### Phase 6A — CaptionLink real-time inference

CaptionLink is the first persistent-session acceptance target.

Target flow:

```text
CaptionLink
    |
    | request speech.streaming
    v
GPULink Core
    |
    | select compatible worker/GPU
    v
Speech inference adapter
    |
    | persistent data plane
    v
live captions
```

CaptionLink continues to own:

- desktop audio capture;
- client-side audio framing;
- caption rendering;
- speaker presentation;
- accessibility UX;
- local buffering;
- client reconnection behavior.

GPULink owns:

- worker selection;
- GPU allocation;
- capability matching;
- adapter readiness;
- model locality;
- lease supervision;
- worker-loss detection;
- durable session lifecycle.

The integration should use capability-shaped identifiers such as
`speech.streaming` and implementation-oriented adapter identifiers rather than
application names in generic Core contracts.

Acceptance must measure real application-level behavior, including:

- request-to-active session time;
- warm-session startup time;
- audio timestamp to first useful partial caption;
- audio timestamp to stable/final caption;
- streaming jitter;
- reconnect interruption;
- worker-loss/replacement behavior;
- local inference baseline versus GPULink remote inference;
- confirmation that audio frames are absent from durable scheduler storage.

The target is not a pre-declared latency number. The first goal is to establish
repeatable end-to-end measurements and then optimize from evidence.

### Phase 6B — Batch / HPC-style client

Build a reference client for finite queued GPU work.

This application should demonstrate:

- capability/resource requirements;
- queueing;
- whole-GPU allocation;
- retries;
- cancellation;
- bounded results;
- longer-running work;
- heterogeneous worker placement;
- job history and observability.

Potential workload classes include:

- benchmarks;
- offline inference;
- conversion;
- rendering;
- training/fine-tuning slices;
- bounded CUDA applications.

The reference client must consume GPULink Core rather than implement a second
scheduler.

### Phase 6C — Secure remote inference client

Build a reference application demonstrating authenticated access to a GPU-backed
service located on another worker.

Potential targets include:

- LLM serving;
- speech inference;
- image-generation services;
- custom model servers.

The goal is to prove:

- session brokering;
- secure worker reachability;
- NAT-tolerant operation;
- relayed data paths;
- optional direct authorized paths;
- session-bound credentials;
- clean teardown and revocation.

This must not reduce GPULink to generic unauthenticated port forwarding.

### Phase 6D — Developer tooling

Optional developer-facing tooling may provide a simple way to inspect available
GPUs, capabilities, adapters, models, jobs, and sessions and launch reference
workloads.

This may become a separate application or remain lightweight tooling.

It is not a prerequisite for Core correctness.

## Phase 7 — Private GPU fleet

**Status: future**

Goal: demonstrate GPULink as private GPU infrastructure for a lab, team,
organization, or other trusted administrative domain.

Potential capabilities include:

- users and service identities;
- projects;
- role-based authorization;
- quotas;
- priorities;
- resource pools;
- project-level accounting;
- usage history;
- fleet administration;
- model inventory;
- operational dashboards;
- policy-aware scheduling;
- maintenance/drain workflows;
- organization-wide observability.

This is where project quotas and priority policy belong rather than in a
single-user scheduler.

Cluster scaling, including multi-node K3s, should remain evidence-driven. It
should be introduced when actual availability, throughput, or control-plane
requirements justify the operational complexity.

Acceptance requires multiple users/projects to share a heterogeneous fleet
without bypassing policy or corrupting scheduler ownership.

## Phase 8 — Cross-trust distributed GPU network

**Status: long-term future**

Goal: determine whether GPULink can safely extend beyond a single trusted
administrative domain.

This phase must precede any marketplace-style product.

Required research and acceptance areas include:

- external worker enrollment;
- provider identity;
- consumer identity;
- stronger workload isolation;
- tenant separation;
- resource attestation where practical;
- usage metering;
- network trust boundaries;
- secure artifact/model handling;
- abuse controls;
- revocation;
- failure and dispute evidence;
- workload-policy enforcement.

Consumer/workstation GPUs must not be assumed to provide datacenter-style
hardware partitioning or isolation.

Hardware, driver, software-license, and commercial-use requirements must be
reviewed for each deployment model rather than inferred from GPU compatibility.

No capacity marketplace should be built until cross-trust execution is shown to
be safe enough for the intended workloads.

## Phase 9 — Capacity exchange

**Status: long-term concept**

Goal: explore an application that connects authorized compute providers with
consumers after cross-trust execution, metering, and policy have been accepted.

A capacity-exchange application may eventually own:

- provider accounts;
- consumer accounts;
- capacity publication;
- pricing;
- billing;
- payment/settlement integration;
- reputation;
- provider availability;
- marketplace policy;
- abuse/dispute workflows.

These are **application responsibilities**, not GPULink Core responsibilities.

GPULink Core may expose generic primitives such as:

- metered allocation;
- authorization;
- resource identity;
- lifecycle evidence;
- usage records.

It must not embed marketplace economics into the scheduler.

Phase 9 is intentionally conditional. It is not a commitment to build a
marketplace merely because the lower-level framework could support one.

## Long-term roadmap principle

Later phases must earn their complexity.

The intended progression is:

```text
reliable scheduler
        |
        v
production GPU fabric
        |
        v
application platform
        |
        v
reference applications
        |
        v
private multi-user fleet
        |
        v
cross-trust network
        |
        v
optional capacity exchange
```

Each phase should be accepted with evidence before the project depends on the
next abstraction.

The roadmap should expand because proven use cases demand additional capability,
not because a larger architecture can be imagined.
