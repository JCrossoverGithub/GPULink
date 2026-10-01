# AWS GPU Workload Acceptance

## Status

PASS

Acceptance date:

    2026-10-01

## Scope

This record covers the first accepted real CUDA workload executed through the
public GPULink AWS control plane by the physical JPCMAIN RTX 3090 Ti worker.

This is a follow-on acceptance to:

    docs/security/aws-control-plane-staging-acceptance.md

That earlier record intentionally excluded physical GPU-worker acceptance and
real GPU workloads. This record extends the accepted boundary to cover those
capabilities.

This was **not an AWS-hosted GPU workload**. AWS hosted the GPULink control
plane. The GPU executing the workload was the physical JPCMAIN worker.

The frozen supporting evidence is:

    docs/security/evidence/aws-control-plane-jpcmain-first-gpu-run-2026-10-01/

## Accepted Run Identity

The accepted job was:

    job ID:     job_aefbe4a66e22481cb15f701d33bf3f06
    project:    gpulink-benchmark
    type:       benchmark.gpu
    status:     succeeded
    attempt:    1

The control plane leased the job to:

    worker ID:  worker_4e79d49450844252bd83dd378bac28ef
    worker:     jpcmain-3090ti
    GPU UUID:   GPU-326a4232-3d30-423b-29a1-66f2d054a0d4
    GPU model:  NVIDIA GeForce RTX 3090 Ti

The GPU UUID in the returned benchmark result exactly matched the GPU UUID
assigned by the control plane.

## Workload Contract

The submitted bounded GPU workload used:

    matrix size:          4096 x 4096
    data type:            float32
    warmup iterations:    3
    measured iterations:  10
    maximum attempts:     2

Runtime reported by the completed worker result:

    backend:              pytorch-cuda
    backend version:      2.12.1+cu130
    CUDA runtime:         13.0

The workload was the repository-owned `benchmark.gpu` adapter. It did not
permit the client to select an arbitrary executable, script, environment, or
output path.

## Durable Lifecycle

The AWS-side control-plane event history recorded this exact sequence:

    job.queued       1790813904206
    job.leased       1790813904211
    job.started      1790813905246
    job.succeeded    1790813907512

Derived AWS-side lifecycle timings were:

| Metric | Value |
| --- | ---: |
| Queue -> lease | 5 ms |
| Lease -> start acknowledgement | 1035 ms |
| Start acknowledgement -> success | 2266 ms |
| Queue -> success | 3306 ms |

These four durable lifecycle timestamps use the AWS control-plane clock.

The `lease -> start acknowledgement` interval describes the time from
control-plane lease assignment until the worker's start request was accepted.
It should not be interpreted as GPU execution time.

## Worker and CUDA Timing

The worker-reported benchmark subprocess duration was:

    2240 ms

That value is process-level wall-clock time, not GPU kernel time. It includes
Python startup, PyTorch import, CUDA/runtime initialization, allocation,
warmup, measured iterations, result serialization, and process teardown.

CUDA-event measurements around the measured matrix multiplications reported:

| Metric | Value |
| --- | ---: |
| Median measured iteration | 5.561344 ms |
| Interpolated sample P95 | 6.388906 ms |
| Measured sample count | 10 |
| Warmup iterations | 3 |
| Peak allocated GPU memory | 200.125 MiB |

The P95 value is based on only 10 measured iterations.
It is retained as an acceptance-run statistic and is **not** presented as a
robust tail-latency characterization.

## Estimated Throughput

The accepted result reported:

    24.713262 TFLOPS

This value is derived from the median CUDA-event iteration time:

    2 * matrixSize^3 / (medianIterationMs / 1000) / 1e12

It is not an independent throughput measurement.

## Timing-Domain Cross-Check

AWS-side start-acknowledgement-to-success latency:

    2266 ms

Worker benchmark-process duration:

    2240 ms

Difference:

    26 ms

The difference is consistent with network round-trip plus worker/API
orchestration overhead. It is retained only as a cross-check and is not
treated as a direct network-latency measurement.

## Public HTTPS Reference Latency

A separate post-run sample of 10 HTTPS requests was
collected against:

    https://gpulink.schultzsystems.com/healthz

The sample was collected at:

    2026-10-01T00:22:00Z

This sample was collected **after** the accepted workload and is explicitly
not the original job-submission latency.

| Metric | Median | P95 | Mean |
| --- | ---: | ---: | ---: |
| TCP connect | 23.386 ms | 25.159 ms | 23.445 ms |
| TLS complete | 47.495 ms | 50.778 ms | 47.746 ms |
| HTTPS TTFB | 68.228 ms | 72.447 ms | 68.090 ms |
| HTTPS total | 68.273 ms | 72.483 ms | 68.127 ms |

## Control-Plane Provenance

The accepted control-plane image digest was:

    sha256:03c5bbdf5487f11abe020cad800192c3ca28c337ede958333bc2be6ac1e18fc5

The control-plane Pod:

    UID:       868a6176-258b-4ea6-8d9a-f607d082ab98
    created:   2026-09-30T18:06:24Z
    restarts:  0

The same zero-restart Pod existed before the accepted job was queued and
remained unchanged through provenance capture. The immutable image digest is
therefore attributable to the accepted workload run.

The public evidence records only the immutable digest, not a private ECR URI
or AWS account identifier.

## Worker Provenance

The worker package version was:

    0.1.0

The installed worker execution closure contained:

    files:    19
    SHA-256:  06a56ec6d76c34bfac5d5d3393f1b4abefb73274441a460b515c6e159070dc1d

The benchmark runner SHA-256 was:

    81679ca2d3ff116e6aef9b9db2061eb86fe7e677efa1a3f587b4b695fc86f343

The worker service began at:

    2026-10-01T00:13:17Z

and had:

    automatic restarts: 0

The installed worker tree does not contain `.git` metadata. Therefore this
acceptance deliberately does **not** claim an exact worker installation
commit.

The matching repository execution closure was last changed by:

    881a29d4efb0da09070a946f29a1c5f51c6c54b2
    Harden GPU benchmark runtime initialization
    2026-09-10T15:56:47-04:00

That commit is recorded as the last source change to the matching execution
closure. It is not asserted to be the exact checkout commit used during
worker installation.

## Freeze-Time Worker Snapshot

`worker-metadata.json` was captured after the workload during evidence
freezing.

Its dynamic fields, including:

- GPU utilization;
- temperature;
- power draw;
- used GPU memory;
- adapter-health `checkedAt`;
- worker `lastSeenAt`;

represent freeze-time state and are **not** claimed to describe GPU state
during benchmark execution.

Benchmark-time assignment, GPU identity, workload parameters, result data,
and lifecycle timestamps come from the durable job and event evidence.

## Evidence Sanitization

The public bundle was built in a private staging directory.

Before integrity hashes were generated, the candidate files were scanned for:

- 12-digit AWS account identifiers;
- private ECR repository URIs;
- AWS access-key identifiers;
- bearer credential values;
- GPULink token assignments;
- credentialed PostgreSQL URLs;
- PEM private keys;
- email addresses;
- the local operator username;
- the local operator home path.

The sanitization scan passed.

The raw operator capture was intentionally not copied into the repository.
Its SHA-256 and byte count are retained in `provenance.json`.

## Integrity

The evidence bundle includes:

    SHA256SUMS

The manifest was generated only after the sanitization scan passed.

The manifest was verified once in private staging and again after the bundle
was moved into the repository.

## Acceptance Result

PASS.

This acceptance proves that:

- the public AWS GPULink control plane accepted a bounded real GPU workload;
- the AWS-side scheduler leased that workload to the expected physical
  JPCMAIN worker and RTX 3090 Ti GPU UUID;
- the worker acknowledged and started the assigned job;
- the physical RTX 3090 Ti executed the PyTorch/CUDA workload;
- the job completed successfully on attempt 1;
- the returned GPU identity matched the assigned GPU identity;
- the completed result was persisted in the AWS-side job state;
- the durable AWS-side event history recorded queue, lease, start, and
  successful completion;
- lifecycle, worker-process, CUDA-event, and post-run HTTPS timing classes
  were preserved separately;
- immutable control-plane runtime provenance was established;
- worker runtime provenance was recorded without inventing an unavailable
  installation commit;
- the public evidence bundle was sanitized before integrity hashes were
  generated.

This acceptance does **not** establish:

- an AWS-hosted GPU execution environment;
- statistically rigorous GPU performance characterization;
- robust P95 or P99 tail latency;
- original job-submission network latency;
- multi-worker scheduling-selection quality;
- sustained-load behavior;
- multi-replica control-plane behavior;
- worker-failure recovery against this AWS deployment;
- production migration completion.

Those remain separate acceptance boundaries.
