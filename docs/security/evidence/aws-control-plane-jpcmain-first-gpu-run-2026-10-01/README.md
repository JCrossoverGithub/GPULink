# First AWS-Control-Plane GPU Workload Evidence

## Scope

This bundle records the first accepted real CUDA workload submitted through
the public GPULink AWS control plane and executed by the JPCMAIN RTX 3090 Ti
worker.

This was **not an AWS-hosted GPU**. AWS hosted the control plane. The physical
GPU worker was JPCMAIN.

## Run identity

- Job: `job_aefbe4a66e22481cb15f701d33bf3f06`
- Job type: `benchmark.gpu`
- Attempt: `1`
- Worker: `jpcmain-3090ti`
- Worker ID: `worker_4e79d49450844252bd83dd378bac28ef`
- GPU: `NVIDIA GeForce RTX 3090 Ti`
- GPU UUID: `GPU-326a4232-3d30-423b-29a1-66f2d054a0d4`
- Status: `succeeded`

## Benchmark contract

- Matrix: `4096 x 4096`
- Data type: `float32`
- Warmup iterations: `3`
- Measured iterations: `10`
- Backend: `pytorch-cuda`
- Backend version: `2.12.1+cu130`
- CUDA runtime: `13.0`

## Result

| Metric | Value |
| --- | ---: |
| Queue -> lease | 5 ms |
| Lease -> start acknowledgement | 1035 ms |
| Start acknowledgement -> success | 2266 ms |
| Queue -> success | 3306 ms |
| Worker benchmark-process wall clock | 2240 ms |
| CUDA iteration median | 5.561344 ms |
| CUDA iteration P95, interpolated sample percentile (n=10) | 6.388906 ms |
| Estimated FP32 throughput | 24.713262 TFLOPS |
| Peak allocated GPU memory | 200.125 MiB |

The `2240` ms worker duration is **not GPU kernel time**. It is
the wall-clock duration of the benchmark subprocess and includes process
startup, PyTorch import, CUDA/runtime initialization, tensor allocation,
warmup, measured iterations, result serialization, and teardown.

The CUDA iteration measurements use CUDA events around the measured matrix
multiplications. The P95 value is based on only 10
observations and should be treated as an acceptance-run sample statistic, not
as a robust tail-latency characterization.

The reported `24.713262` TFLOPS value is derived from the median
CUDA-event iteration time using:

`2 * matrixSize^3 / (medianIterationMs / 1000) / 1e12`

It is not an independent throughput measurement.

## Lifecycle evidence

The AWS-side durable event timeline records:

- queued: 1790813904206
- leased: 1790813904211
- started: 1790813905246
- succeeded: 1790813907512

All four durable lifecycle events are stamped by the AWS-side control-plane
clock.

The benchmark result additionally contains worker-owned process timestamps
and the `2240` ms worker-side duration.

The difference between AWS-side start-to-success latency and worker-measured
benchmark-process duration is `26` ms. That is consistent
with network round-trip plus worker/API orchestration overhead, but it is not
a direct network measurement.

## Public HTTPS reference latency

A separate 10-request `/healthz` sample was collected after the benchmark.
It is **not the original job-submission latency**.

| Metric | Median | P95 | Mean |
| --- | ---: | ---: | ---: |
| TCP connect | 23.386 ms | 25.159 ms | 23.445 ms |
| TLS complete | 47.495 ms | 50.778 ms | 47.746 ms |
| HTTPS TTFB | 68.228 ms | 72.447 ms | 68.090 ms |
| HTTPS total | 68.273 ms | 72.483 ms | 68.127 ms |

## Provenance

`worker-metadata.json` was captured during evidence freezing after the benchmark completed. Its dynamic fields—including GPU utilization, temperature, power draw, memory usage, adapter-health `checkedAt`, and `lastSeenAt`—describe the later freeze-time worker state and are **not** benchmark-time measurements. Run-time assignment, GPU identity, workload parameters, result data, and lifecycle timestamps come from the durable job and event records.

The control-plane image digest is attributable to this run because the same
zero-restart pod existed before the job was queued and remained unchanged
through provenance capture.

The worker installation does not contain `.git` metadata. Therefore this
bundle deliberately does **not** claim an exact installed worker Git commit.
Instead it records the installed execution-closure SHA-256, benchmark-runner
SHA-256, service start time, file modification boundary, package version, and
the last repository commit that changed the matching execution closure.

See `provenance.json` for the exact provenance statement and limitations.

## Files

- `source-snapshot.json` — sanitized AWS-side job, worker, event, and control-plane snapshot
- `job-result.json` — public-safe submitted workload and result
- `worker-metadata.json` — public-safe post-run/freeze-time worker capabilities and GPU inventory; dynamic telemetry is not asserted to represent benchmark-time GPU state
- `event-timeline.json` — durable lifecycle events for this job
- `latency-summary.json` — lifecycle, worker, CUDA, and HTTPS latency classes
- `https-latency-samples.csv` — 10 post-run public HTTPS samples
- `provenance.json` — control-plane and worker runtime provenance
- `SANITIZATION.txt` — sanitization process and scan result
- `SHA256SUMS` — integrity hashes generated only after sanitization passed
