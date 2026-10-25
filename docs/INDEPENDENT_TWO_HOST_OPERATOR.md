# GPULink independent two-host operator readiness (design candidate)

**Status:** PR #28 offline configuration and transport-policy contract only. Not an
installed, run, remotely TLS-verified, or physically accepted two-host deployment.
See [capability status](CAPABILITY_STATUS.md) for dated acceptance boundaries.

## Roles and trust boundaries

- **Host A (disposable Linux control plane):** one Node.js 24+ control-plane
  process with `GPULINK_CONTROL_HOST=127.0.0.1`, disposable single-instance
  SQLite persistence, and separately operated HTTPS ingress. The internal HTTP
  backend must be unreachable from Host B or untrusted interfaces.
- **Host B (separate physical GPU worker):** Node.js 24+, operator-approved GPU
  runtime, unique `GPULINK_WORKER_NAME`, and outbound authenticated HTTPS to
  Host A. No GPULink inbound worker listener is required. WSL is not required.
- **Authorized caller:** `GPULINK_URL` and client/admin-scoped bearer supplied
  by the operator; do not use worker/admin tokens in an application Client SDK.
- **Trust:** hostname-matched, independently trusted TLS chain, without
  certificate-verification bypass or authentication redirects. Real TLS proof
  is a later gate, not an offline parser result.

## Reuse existing configuration; do not invent enrollment or a manifest

The required control-plane values are `GPULINK_CLIENT_TOKEN`,
`GPULINK_WORKER_TOKEN`, `GPULINK_ADMIN_TOKEN`, and
`GPULINK_DATA_PLANE_SIGNING_KEY` — **four distinct**, randomly provisioned
values at least 32 characters each. Current worker token is scoped to the
**deployment role**, not proven individually issued/revocable per device.
Only reference secret storage locations in published documentation; never
commit, log, or paste actual values, certificates, fingerprints, or keys.

Use existing `loadControlPlaneConfig`, `loadWorkerConfig`, and `gpulink doctor`
for source-level validation. A non-loopback control-plane bind currently produces a
`doctor` **warning**, not a configuration-parser failure; independent two-host
acceptance must separately verify the Host A loopback-only boundary at G1/G2.
`GPULINK_CONTROL_PLANE_URL` on Host B and
`GPULINK_URL` for remote operator CLI requests require HTTPS for non-loopback
hosts. Plain HTTP is allowed only for exact localhost loopback, for local
single-machine development. `doctor` does not establish live TLS trust, GPU
availability, or service/process ownership. The source `.env.example` is a
**non-runnable template with deliberately invalid placeholder secrets**;
provision each host's actual values privately and separately.

The managed `gpulink init local`, `local start/stop`, and local worker preview
apply only to generated localhost installations, not remote provisioning.
Do not use the historical WSL-specific worker installer as a native Linux
installer. The GPULink CLI/SDK is not a remotely deployable service manager.

## Gate sequence — require separate authorization for side effects

| Gate | Purpose | Permission boundary |
| --- | --- | --- |
| G0 | Exact revision, host inventory and ownership | Read-only |
| G1 | Operator TLS name/issuer, role credentials and locations | Offline plan; no secret generation |
| G2 | Disposable Host A CP behind loopback-only backend | Separate opt-in provisioning/start |
| G3 | Host B validates chain and exact hostname, fails invalid identity | Authorized read-only remote connection |
| G4 | Register independent Host B and real GPU inventory | Separate opt-in worker start; can accept jobs |
| G5 | One allowlisted `diagnostic.gpu-status`, GPU UUID, lease, result | Separate explicit physical GPU consent |
| G6 | Persisted results and controlled restart/recovery | Only with known execution ownership |
| G7 | Scoped auth, TLS, cleartext, stale heartbeat negatives | Bounded explicit tests |
| G8 | Worker before CP; ownership-verified cleanup | Separate opt-in teardown |
| G9 | Redacted dated evidence and residual gaps | No secrets |

No PID-only termination, credential reuse, TLS bypass, arbitrary CUDA jobs,
AWS/DigitalOcean changes, new installer, per-worker revocation protocol,
Kubernetes, or production-readiness claims are authorized by this document.
If a live job's physical execution ownership is uncertain, quarantine it;
lease expiry alone does not authorize immediate reassignment or cleanup.

**PR #28 acceptance:** zero-network tests of existing parsers and HTTPS/redirect
policy plus documentation consistency. This does not count as G2–G9 acceptance.

## Post-contract execution evidence — October 24, 2026

This document's PR #28 *offline readiness* scope remains historical and is not retroactively recast as live acceptance. A separately authorized operator-guided test of exact revision `c88b9f8e795399d73d74b9b34a9c157728de2600` subsequently completed G0–G8 on two physical computers, including one physical `diagnostic.gpu-status` job, persistence/restart recovery, role authentication and TLS negatives, stale-heartbeat recovery, and reversible teardown. See [dated G9 evidence](acceptance/independent-two-host-acceptance-2026-10-24.md). This is not a tested installable cross-host workflow, uncontrolled failure recovery, or a general production-readiness claim.
