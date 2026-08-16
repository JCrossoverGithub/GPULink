# First Operational Target Handoff

## Delivered

This branch provides the software and deployment assets needed to prove the
first physical GPUlink path:

1. An authorized client submits a durable diagnostic job over public HTTPS.
2. The DigitalOcean control plane selects an eligible GPU and creates an
   exclusive, expiring lease.
3. A Windows/WSL worker receives the lease through outbound HTTPS polling.
4. The worker invokes only the allowlisted `nvidia-smi` diagnostic for the
   assigned GPU UUID.
5. The client retrieves the terminal result from the authoritative API.

It also provides separate client, worker, and administrator credentials,
drain/resume controls, restartable services, persisted SQLite state, metrics,
events, and cross-platform CI.

## Acceptance boundary

Automated tests verify API authorization, scheduling, retries, expiry,
cancellation, persistence, and the worker lifecycle. The remaining acceptance
work requires the operator's real infrastructure:

- a DNS hostname pointed to the DigitalOcean droplet;
- the control-plane and Caddy services installed on the droplet;
- WSL2 workers enrolled on the RTX 3070 Ti desktop and RTX 4060 laptop;
- the diagnostic, drain/resume, restart, persistence, and external-access
  checks in `docs/FIRST_OPERATIONAL_TARGET.md` completed.

The target is not considered accepted until those hardware checks pass.

## Deliberately deferred

- Parakeet and the TransGo streaming adapter
- local LLM model serving
- the operations dashboard and historical telemetry store
- per-worker and per-project revocable credentials
- arbitrary user-supplied command, Python, or container execution
- multi-GPU and cross-machine model parallelism

The next implementation target is Parakeet and adapter hardening after this
diagnostic milestone is accepted on both current Windows machines.
