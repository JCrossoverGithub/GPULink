# Roadmap

## First operational target — Secure heterogeneous fleet

- Durable control-plane database
- Worker enrollment and heartbeat
- NVIDIA GPU discovery
- Capability and minimum-VRAM constraints
- Exclusive leases
- Retry, expiry, cancellation, drain, and stale-worker behavior
- Server-sent operational events
- Prometheus-format platform metrics
- Tested worker and job lifecycle contracts
- Docker-isolated DigitalOcean control plane behind Nginx HTTPS
- Outbound-only WSL2 worker services on Windows hosts
- Separate client, worker, and administrator credentials
- Allowlisted per-GPU `nvidia-smi` diagnostic workload
- CLI enrollment verification, drain, resume, and job inspection
- Linux and Windows continuous integration

Exit criterion: the RTX 3070 Ti desktop and RTX 4060 laptop register through
the public HTTPS gateway, each completes a diagnostic job on its assigned GPU,
drain/resume works, and authoritative state survives a droplet service restart.

## Real GPU benchmark workload

- Versioned, strictly bounded `benchmark.gpu` request and result contracts
- Fixed float32 PyTorch CUDA matrix multiplication
- Isolated pinned Python runtime under `/opt/gpulink/runtime`
- Runtime health-gated capability advertisement
- Fixed executable and script launch without a shell
- Output limits, timeout, cancellation, and process-group cleanup
- GPU-independent CI through an injected process runner
- CLI submission and two-worker comparison workflow

Exit criterion: both physical GPUs complete the benchmark independently and
concurrently, failure paths remain bounded, one-job-per-GPU scheduling still
holds, and neither worker gains an inbound listener or arbitrary execution path.

## Operations console foundation — brought forward

- Loopback Flask backend-for-frontend
- Angular fleet and scheduler overview
- Worker health and drain-state visibility
- GPU memory, utilization, temperature, and power telemetry
- Recent bounded job history without payload or result exposure
- Five-second polling with last-valid-snapshot behavior
- Server-side ownership of administrator and client credentials
- Backend tests and a production Angular build check in CI

This read-only slice is intentionally delivered ahead of the full operations
dashboard milestone. Authenticated public deployment, historical time-series
storage, and administrative actions remain in Milestone 4.

## Milestone 2 — Parakeet and adapter hardening

Foundation delivered in the current development branch:

- Versioned, strictly validated `speech.streaming` session metadata
- Fixed `transgo-v1` 16 kHz mono PCM/100 ms audio contract
- Explicit exclusion of audio data and transport controls from durable jobs
- Central workload-contract registry for model-specific validation
- Versioned adapter manifests with fixed execution-mode metadata
- Readiness-filtered manifest advertisement and durable worker inventory
- Backward-compatible database migration for existing workers

Remaining work:

- Allowlisted process/container launcher
- Per-adapter health and readiness
- Worker-side cancellation and cleanup
- Local model cache inventory
- Hashed, revocable, scoped worker credentials
- Per-worker availability and resource-reserve policies
- Priority preemption rules for interactive desktop use
- Parakeet adapter and existing `/v1/transcription` compatibility gateway
- Streaming session metrics and clean reconnect behavior

The existing TransGo contract remains stable while its GPU execution moves
behind GPUlink.

## Milestone 3 — Local LLM service

- vLLM adapter on the 24 GB worker
- Native GPUlink model-serving API
- Optional OpenAI-format compatibility adapter for existing clients
- Model registry and local cache placement
- Resident-model-aware scheduling
- Tokens/second, time-to-first-token, queue, and KV-cache metrics
- Smaller llama.cpp/GGUF adapter for constrained workers
- Project quotas and per-model concurrency

The normal mode is one complete model or replica per worker. Cross-machine
model splitting is not required for this milestone.

## Milestone 4 — Operations dashboard

- Node/GPU health and availability
- Memory, utilization, temperature, power, and throttling
- Active leases and queued jobs
- Model residency and cache status
- P50/P95/P99 application latency
- Drain/resume and safe administrative actions
- Historical views through Prometheus and Grafana

## Milestone 5 — Advanced scheduling

- Multi-GPU jobs on one computer
- Reservation pools for latency-sensitive services
- Batch backfilling
- Maintenance windows
- Per-project fairness
- Optional Ray integration for supported distributed workloads
- Experimental cross-machine pipeline parallelism

Any distributed single-model mode must be separately benchmarked on the actual
LAN and may not weaken the reliability of independent workload scheduling.
