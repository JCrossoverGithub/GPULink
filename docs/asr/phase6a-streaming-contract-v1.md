# Phase 6A — Streaming ASR application protocol v1

Status: PROPOSED — not yet implemented.
Baseline: bc39f4599588e62d9982ed2dff165a1e65066c40.

## Scope and compatibility

The application protocol identifier is `gpulink.asr.v1`.

This protocol is carried over an existing authenticated GPULink
data-plane session. It must not change `/v1/data-plane`, the
WebSocket grant mechanism, the v1 worker transport, or the
opt-in v2 `gpulink.relay.ready.v2` signal.

Relay readiness means authorization and pairing only.
It is not ASR runtime readiness.

The initial adapter uses:
- manifest schemaVersion 2
- executionMode `streaming-gateway`
- capability type `speech.streaming.single`
- a distinct, versioned adapterId

The production worker must register this adapter explicitly.
No capability is advertised merely because a model is listed
in the local inventory.

## Audio format

Audio is mono signed PCM16LE, sampled at 16,000 Hz.

Audio uses binary WebSocket messages containing:

| Offset | Size | Field |
|---|---:|---|
| 0 | 4 | ASCII magic `ASR1` |
| 4 | 4 | uint32 LE sequence number |
| 8 | 4 | uint32 LE starting sample offset |
| 12 | 4 | uint32 LE number of audio samples |
| 16 | variable | PCM16LE samples |

The binary frame length must equal 16 + 2 * sampleCount.

The first frame has sequence 0 and sample offset 0.
Later frames must be sequential and sample-contiguous.
Duplicate, missing, reordered, overlapping, or malformed frames
are protocol errors. Integer wraparound is rejected.

The initial benchmark uses 40 ms frames: 640 samples and
1,296 total bytes. This is a test default, not a model-specific
decoding-window requirement.

The existing GPULink maximum frame size remains 1,048,576
bytes. Implementations must also apply stricter application
limits for frame duration, queue capacity, and session duration.
Those limits must be finalized before runtime integration.

## Application control messages

Text WebSocket frames contain UTF-8 JSON objects.
Every message has one exact, versioned `type`.
Unknown types, directions, or fields must fail closed.
The proposed maximum JSON message size is 16 KiB.

Client to worker:

- `asr.start.v1`: selects PCM16LE, 16 kHz, mono; exactly once
- `asr.end.v1`: declares end of audio input
- `asr.cancel.v1`: requests termination

Worker to client:

- `asr.model_ready.v1`: model artifacts verified, model loaded,
  runtime initialized, and warm-up successful
- `asr.partial.v1`: replaceable hypothesis for one segment
- `asr.final.v1`: immutable final hypothesis for one segment
- `asr.completed.v1`: all accepted input finalized
- `asr.cancelled.v1`: cancellation acknowledged
- `asr.error.v1`: sanitized terminal failure

Partial and final transcripts identify a segment, revision,
startSample, and endSample. Revisions must increase within
a segment. A final segment cannot be revised.

A client's start message must not override the server-allocated
GPU, model identity, pinned model revision, or adapter identity.
The worker must bind model readiness to those allocated values.

Do not treat an `asr.model_ready.v1` message as a GPULink relay
control message. It is an application-level message.

## Lifecycle

ALLOCATION
  -> RELAY_PAIRED
  -> MODEL_LOADING
  -> MODEL_READY
  -> STREAMING
  -> DRAINING
  -> COMPLETED

Any active state may transition to FAILED or CANCELLED.

No audio inference begins before MODEL_READY. The client
must not assume pairing implies model readiness.

End-of-input transitions to DRAINING, which waits for final
segments before a successful completion acknowledgment.

Session cancellation, lease loss, client disconnection,
worker shutdown, subprocess crash, and timeout must cause
bounded cleanup.

The application may observe an unexpected socket closure
without a terminal message. That outcome is not success.

## Isolation and failure behavior

Inference runs in an independently supervised process.
The worker agent retains lease and session ownership.

The supervisor must provide:
- bounded startup and model initialization deadlines
- bounded input and output queues
- backpressure without silent audio loss
- sanitized stderr and protocol errors
- SIGTERM with bounded SIGKILL escalation
- process exit and GPU resource cleanup verification

Failures must distinguish:
- model_integrity_failed
- model_load_failed
- cuda_oom
- inference_failed
- runtime_timeout
- input_invalid
- backpressure_limit
- lease_lost
- internal_error

All failure codes are subject to final implementation review.
Never send stack traces, local paths, credentials, tokens,
or raw audio through public error messages.

## Artifact integrity

The existing model inventory is an availability inventory,
not a cryptographic integrity or execution-safety guarantee.

Before loading a model:
- pin the upstream revision to an immutable identifier
- verify SHA-256 for every required model artifact
- reject missing, extra executable, or mismatched files
- prohibit unreviewed remote code execution
- prefer safetensors and restricted deserialization
- keep cache paths local to the worker
- keep model downloads outside the worker's inference path

A hash match alone does not prove that deserialization,
model code, or dependencies are safe. Dependency and loader
allowlisting are separate security controls.

No real model weights or deployment-local paths belong in Git.

## Performance evaluation

Compare one pinned model on one GPU with the same fixture,
decoder settings, audio pacing, and warm-up conditions.

Record:
- artifact verification and download separately
- cold initialization from already cached weights
- warm first-partial latency
- p50 and p95 input-to-transcript latency
- inference real-time factor
- GPU memory and utilization
- GPULink application overhead
- isolated relay echo RTT and forwarding latency
- error and recovery rates

Use monotonic timing within each process. Do not directly
subtract timestamps from unsynchronized machines.

Measure streaming wall-clock responsiveness separately
from unpaced model computation real-time factor.

The initial workload uses exclusive GPU allocation.
Multi-model residency and VRAM oversubscription are out
of scope for this phase.

## Acceptance boundaries

This specification and its fixtures do not implement
a runtime, validator, sidecar, or model loader.

The next implementation must add executable validators
and negative protocol tests before live inference.

No service changes, deployment, model installation,
GPU workload, or npm publication is authorized here.
