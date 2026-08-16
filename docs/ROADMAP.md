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

## Milestone 2 — Parakeet and adapter hardening

- Adapter manifest and version contract
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
