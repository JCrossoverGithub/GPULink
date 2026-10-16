# DP3C3B2C2B2C2 — Test-only host broker binding to authoritative claims

## Safety and scope

This is an **opt-in test-only**, **non-executing** integration of the B2B Linux
Unix-socket broker with B2C2B2C1's broker-scoped HTTP reservation endpoint.
It does **not** attest physical host identity, prove GPU isolation, enable OCI,
start child processes, clear fences, or authorize a workload to launch. Production
host brokers MUST NOT use this unfinished test-only server.

The existing B2B fixture-backed `claim`, `inspect`, and `cancel` operations are
unchanged. The additional `reserve-authoritative` operation can be enabled only
by passing `--test-only` and `--authority-config`. The worker-side helper
`reserveAuthoritativeBrokerAttempt` is only an internal developer/test API,
**not** part of the public Client SDK. No control-plane endpoint is added in
this stage; the B2C2B2C1 endpoint remains default disabled.

## Authority and trust flow

1. Local caller connects to a Unix-domain socket owned by the broker process.
2. Broker obtains kernel `SO_PEERCRED` UID and maps it through its operator-owned
   fixture to the one configured `workerId`. The caller cannot supply a UID,
   worker, project, GPU UUID, runtime, binary, digest, host command, approval,
   timestamp or isolation policy.
3. Broker writes a **pending** attempt to its SQLite singleton journal and
   commits durably **before** network I/O. Attempt IDs are never reusable.
4. Broker sends only `{schemaVersion:1,subjectKind,subjectId,leaseId,attemptId}`
   to `/v1/broker/attempts/reserve`, authenticating with the privately injected
   broker credential. The control plane obtains worker/GPU/approval/time from
   operator config and authoritative DB, checks current lease and atomically
   persists the GPU fence and execution attempt under scheduler's lock.
5. A strictly checked HTTP 201 response can mark the **local** journal reserved,
   returning `canLaunch:false`. Any HTTP error, connection failure, bad response,
   local DB error or interruption is **uncertain**. It is NEVER retried
   automatically, nor translated into a cleared GPU.
6. On any broker restart, `pending` and `reserved` attempts become `quarantined`.
   The remote fence is not changed. Until a separate cleanup protocol is built,
   neither an operator nor a client can safely release this held resource.

### Why journal before network

A remote DB commit can succeed even if its response is lost. Without a durable
local pending tombstone the caller could replay the same attempt and incorrectly
infer that the first request failed. This conservative journal deliberately
trades availability for correctness and never issues launch authority.

### Operator-only configuration (not checked into Git)

`--authority-config /operator/private/bridge-config.json` points to a regular
file owned by the broker process account with permissions `0600`, containing
**exactly**:

```json
{
  "schemaVersion": 1,
  "workerId": "worker_id_registered_in_control_plane",
  "baseUrl": "https://your-tls-secured-control-plane.example:443",
  "tokenFile": "/operator/private/broker-credential"
}
```

The token file must also be regular, broker-owned and `0600`; it contains only
the ASCII token with **no newline**. Do **not** put real token/config files,
certificates or private keys into the GPULink repo, handoff ZIPs or logs.
Both files are opened with `O_NOFOLLOW` and validated for owner/mode/type.
**HTTP is permitted only for `127.0.0.1` or `::1` loopback**, primarily for
integration tests. Remote hosts require HTTPS using the operating system's
normal CA and hostname verification; no redirects or HTTP proxy are followed.
The operator must separately configure B2C2B2C1 `GPULINK_BROKER_PROFILES_JSON`
with a matching scoped broker identity. Credentials must be protected by host
OS accounts (ideally distinct worker/broker UIDs); the current test fixture
is NOT attestation, and bearer tokens alone do not establish host integrity.

Local operation request through versioned length-prefixed Unix socket:

```json
{
  "schemaVersion": 1,
  "operation": "reserve-authoritative",
  "payload": {
    "subjectKind": "session",
    "subjectId": "session_example",
    "leaseId": "lease_example",
    "attemptId": "attempt_unique"
  }
}
```

Verified success is advisory and **never launchable**:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "schemaVersion": 1,
    "attemptId": "attempt_unique",
    "fenceEpoch": 1,
    "status": "reserved-not-launchable",
    "advisoryOnly": true,
    "canLaunch": false
  }
}
```

## Threat and failure boundaries

- Local peer UID from kernel, not JSON. This is Linux-specific host tooling;
  **GPULink client developers do not need Linux/WSL**. Host providers can run
  a supported broker environment separately from application developers.
- A malicious compromised broker OS identity or stolen bearer credential remains
  out of scope here; mTLS/service workload identity, broker hardening, peer
  process attestation and key rotation are future work.
- Missing/invalid operator config fails before Unix socket accepts connections.
- No secret enters an API response. Responses/errors are bounded; outgoing
  service does not follow redirects or honor HTTP proxies.
- A permanently quarantined local request may correspond to either a remote
  committed fence or a remote denial; no automatic retry or manual unblock API.
- Legacy B2B fixture claims remain test-only and separate, do not provide
  authority to release a control-plane fence.
- No real GPU, OCI, subprocess launch or production deployment is exercised.

## Acceptance gates

1. Exact source-guarded 75-path baseline and 78-path resulting source, with
   existing PostgreSQL migration SHA-256s unchanged.
2. Non-executing Unix-socket -> live **SQLite-backed test control plane**
   integration, OS peer mismatch, shape/accessor injection, unauthorized project,
   duplicate claims, restart replay, disabled default and network outage.
3. All existing B2B tests must still pass. Root repository checks and TypeScript
   SDK build/tests run on JPCMAIN.
4. Disposable PostgreSQL acceptance must pass with existing C1 broker-scoped
   reservation and B2B atomic-claim tests: full root checks with 0 skips.

Next: strengthened host identity/provisioning, durable host execution-state
reconciliation, verified cleanup evidence, exact epoch-matched fence release,
then (only after separate acceptance) real OCI runtime security certification.
