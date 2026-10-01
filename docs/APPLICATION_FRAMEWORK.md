# GPULink Application Framework

## Purpose

GPULink is the application-agnostic GPU orchestration layer.

Its responsibility is to turn a collection of heterogeneous GPU machines into
a schedulable compute fabric while leaving product-specific behavior in the
applications that consume that fabric.

GPULink Core owns resource management, scheduling, execution contracts,
authentication, lifecycle state, and observability.

Applications built on GPULink own their product experience and domain-specific
behavior.

This separation allows the same GPULink deployment to support conventional
finite GPU jobs, persistent real-time inference sessions, private organizational
GPU fleets, remote inference access, and other applications without embedding
those products directly into the core scheduler.

## Framework boundary

### GPULink Core owns

GPULink Core is responsible for:

- worker identity and enrollment;
- GPU discovery and inventory;
- GPU capability and VRAM reporting;
- adapter manifests and adapter health;
- model-cache and warm-model inventory;
- authenticated application access;
- workload validation;
- resource matching and scheduling;
- exclusive GPU ownership where required;
- leases and lease expiry;
- retry and stale-worker behavior;
- drain and resume;
- durable job lifecycle state;
- durable session lifecycle state when persistent sessions are implemented;
- durable operational events;
- application-independent usage and execution metadata;
- control-plane observability;
- safe worker communication;
- execution-policy enforcement.

The core should expose reusable primitives rather than implement the behavior of
a specific application.

### Applications own

Applications built on GPULink are responsible for:

- user-facing workflows;
- domain-specific UI;
- application-specific data;
- product-specific configuration;
- application-specific result presentation;
- application-specific retry or degradation UX;
- business logic;
- billing or pricing;
- marketplace behavior;
- organization-specific policy UX;
- domain-specific media processing before or after GPULink execution.

For example, CaptionLink owns desktop audio capture, caption rendering, speaker
presentation, reconnection UX, and accessibility behavior. GPULink owns the
allocation and supervision of the GPU resources used to perform the inference.

## Execution primitives

GPULink should support two first-class execution shapes.

### Jobs

A job is finite work with a bounded lifecycle.

```text
queued
  |
  v
leased
  |
  v
running
  |
  +------> failed
  |
  v
succeeded
```

Typical examples include:

- GPU benchmarks;
- batch inference;
- model conversion;
- rendering;
- training or fine-tuning slices;
- offline media processing;
- bounded CUDA workloads.

Jobs use the durable scheduler lifecycle directly.

Input metadata is validated and bounded. Large payloads should use an
appropriate data path rather than being copied into scheduler state.

### Sessions

A session is a longer-lived allocation for latency-sensitive or interactive
work.

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

A session reserves compatible compute once and then maintains a data path for
many inference operations.

Typical examples include:

- live speech recognition;
- real-time diarization;
- interactive LLM inference;
- vision streams;
- remote model-serving connections;
- other stateful GPU-backed services.

The control plane remains authoritative for allocation and lifecycle, but
latency-sensitive application data does not transit the durable scheduler
database.

## Control plane and data plane

GPULink deliberately separates scheduling from application data transport.

```text
Application
    |
    | resource/session request
    v
GPULink Control Plane
    |
    | allocation / lease
    v
Selected GPU Worker

Application <========== data plane ==========> GPU workload
```

The control plane answers questions such as:

- which worker may execute the workload;
- which GPU is reserved;
- whether the worker is healthy;
- whether the required adapter is ready;
- whether the required model is cached or warm;
- how long the allocation remains valid;
- what happens when a worker disappears.

The data plane carries the latency-sensitive or high-volume application data.

For a batch workload, that may be a bounded artifact transfer.

For a real-time workload, that may be a persistent bidirectional stream.

PostgreSQL remains the authority for scheduler-visible state. It is not an
audio, video, token, tensor, or media transport.

## Capability-oriented scheduling

Applications should request capabilities rather than specific machines whenever
possible.

Conceptually:

```json
{
  "execution": "session",
  "capability": "speech.streaming",
  "requirements": {
    "minVramMiB": 16384,
    "adapter": "captionlink.streaming"
  },
  "preferences": {
    "warmModels": [
      "multitalker-parakeet",
      "nemotron-diarization"
    ]
  }
}
```

This is an architectural example, not a promise of the exact final wire schema.

The scheduler may consider:

1. required capability;
2. required adapter health;
3. minimum VRAM;
4. GPU availability;
5. warm-model locality;
6. verified model-cache locality;
7. worker freshness;
8. drain state;
9. application/project policy;
10. future scheduling priorities.

Applications should not need to know whether the selected compute resource is a
desktop GPU, laptop GPU, workstation GPU, on-premises server, or cloud GPU.

## Warm-model locality

Latency-sensitive workloads benefit from distinguishing three states:

```text
model unavailable
model cached
model warm
```

A cached model can be loaded without fetching it again.

A warm model is already resident in the serving process or GPU execution
environment and can begin inference with less startup work.

For real-time applications, the scheduler should be able to prefer an otherwise
compatible worker with the required models already warm.

Warm-model preference must remain a scheduling optimization rather than an
application-specific special case.

## Application contract

An application should interact with GPULink through a stable application-facing
contract.

The eventual SDK/API should make common operations look conceptually like:

```text
discover capabilities
submit finite job
wait for job
request session
connect to session data plane
renew/observe session
close session
observe lifecycle events
```

Applications should not need direct knowledge of:

- PostgreSQL;
- Kubernetes or K3s;
- ECR;
- AWS;
- advisory locks;
- scheduler internals;
- worker heartbeat implementation;
- recovery storage;
- deployment topology.

Those are GPULink implementation details.

## Real-time session example: CaptionLink

CaptionLink is the first concrete reference application for the session model.

CaptionLink requires near-real-time speech inference while preserving its own
desktop capture and caption-rendering behavior.

A target allocation flow is:

```text
CaptionLink
    |
    | request speech.streaming
    v
GPULink
    |
    | match capability, VRAM, adapter health,
    | model locality, and worker availability
    v
JPCMAIN / RTX 3090 Ti
    |
    | reserve GPU + streaming adapter
    v
session allocated

CaptionLink ===== audio stream =====> speech adapter
CaptionLink <==== interim captions === speech adapter
CaptionLink <==== final captions ===== speech adapter
CaptionLink <==== speaker metadata === speech adapter
```

Only the session lifecycle belongs in durable GPULink state.

Individual audio frames do not become scheduler jobs.

CaptionLink continues to own:

- audio capture;
- the client-side PCM contract;
- caption rendering;
- speaker presentation;
- local buffering;
- client reconnection UX;
- accessibility-specific behavior.

GPULink owns:

- worker selection;
- GPU allocation;
- adapter readiness;
- model locality;
- resource exclusivity;
- session authorization;
- lease supervision;
- worker-loss detection;
- replacement allocation policy;
- durable session lifecycle events.

## Data-plane options

The application framework should not require one transport for every workload.

Possible session data-plane strategies include:

### Relayed

```text
Application
    |
    v
GPULink gateway
    |
    v
Worker
```

Advantages:

- predictable NAT traversal;
- centralized authentication boundary;
- simpler initial deployment.

Tradeoff:

- the relay participates in every data-path round trip.

### Direct authorized connection

```text
               allocation
Application -------> GPULink
                       |
                       v
                     Worker

Application <=======> Worker
          direct data plane
```

Advantages:

- lower latency;
- less central bandwidth;
- useful for real-time media and high-throughput inference.

Tradeoff:

- NAT traversal and secure endpoint establishment become more complex.

GPULink may eventually support both. The control plane remains authoritative in
either design.

## Reference applications

Reference applications should demonstrate independent uses of the same core
framework.

### CaptionLink

Status: existing external project / first real-time integration target.

The GPULink integration is intended to demonstrate:

- persistent sessions;
- low-latency inference;
- warm-model scheduling;
- streaming ASR;
- diarization;
- session recovery.

### GPULink Batch

Status: future reference application.

Would demonstrate:

- SLURM-like finite job submission;
- GPU requirements;
- queueing;
- retries;
- resource accounting;
- batch workload observability.

It should consume GPULink Core rather than become a second scheduler.

### GPULink Relay

Status: future reference application.

Would demonstrate:

- authenticated remote access to GPU-backed services;
- secure worker reachability;
- session brokering;
- direct or relayed data planes.

It must not reduce GPULink to an unauthenticated port-forwarding system.

### GPULink Fleet

Status: future reference application.

Would demonstrate organizational use of GPULink:

- projects;
- users;
- policy;
- quotas;
- fleet administration;
- GPU accounting;
- model inventory;
- operational dashboards.

Organization-specific UX belongs here rather than in GPULink Core.

### GPULink Exchange

Status: future concept.

Would demonstrate external capacity sharing or marketplace behavior.

Pricing, payments, provider reputation, consumer billing, and marketplace policy
must remain outside GPULink Core.

The core may eventually expose generic metering and authorization primitives that
an Exchange application can consume.

## SDK direction

A future GPULink SDK should be a thin application-facing layer over stable
platform APIs.

Conceptually:

```python
client = GPULink(...)

session = client.sessions.create(
    capability="speech.streaming",
    min_vram_gib=16,
)

stream = session.connect()
```

and:

```python
job = client.jobs.submit(
    capability="benchmark.gpu",
    requirements={"minVramMiB": 8192},
)

result = job.wait()
```

These examples describe the desired abstraction, not committed SDK syntax.

The SDK must not hide unsafe behavior or bypass scheduler ownership.

## Repository boundary

The GPULink repository should contain:

- core scheduler and control-plane code;
- worker runtime;
- shared workload/session contracts;
- generic adapters where appropriate;
- SDKs;
- infrastructure;
- tests;
- reference integration contracts;
- architecture and operations documentation.

Separate application repositories may contain:

- CaptionLink;
- GPULink Batch;
- GPULink Relay;
- GPULink Fleet;
- GPULink Exchange;
- other products built on the framework.

A reference application may live in this repository temporarily during early
development if doing so materially improves testing, but application-specific
business logic should not become a permanent dependency of GPULink Core.

## Design test

A useful architectural test for every new GPULink feature is:

> Could two unrelated applications use this primitive without either application
> being named or hard-coded in the core scheduler?

If yes, it is probably a GPULink Core capability.

If no, it probably belongs in an application or adapter layer.

## Current implementation boundary

The current repository already implements the finite-job scheduling foundation:

- durable job state;
- worker inventory;
- leases;
- GPU-aware scheduling;
- adapter manifests and health;
- model-cache inventory;
- worker heartbeat and drain behavior;
- bounded retries;
- PostgreSQL coordination;
- durable events;
- real CUDA workload execution.

The repository also contains the beginning of a streaming application contract
through `speech.streaming`, including bounded scheduling metadata and the
explicit exclusion of audio frames from durable scheduler state.

Persistent session allocation, session data-plane establishment, session
recovery, and the application SDK remain future implementation work.

This document defines the architectural direction without claiming those
features are already complete.
