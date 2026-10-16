# DP3C3B2C2B2C1 — Broker-scoped reservation API (candidate)

**Safety:** This is an opt-in, non-executing control-plane reservation endpoint. It
never authorizes container creation or GPU workload launch. All success responses
include `canLaunch:false`; there is no runtime integration or physical cleanup API.

## Responsibility boundaries

- The scheduler retains exclusive placement authority. The broker cannot choose
  a GPU or assign a worker by making a reservation request.
- Each operator-provisioned broker identity is statically scoped to one currently
  registered **worker ID**, one **project ID**, and one immutable approval profile.
- The control plane derives `workerId` from its broker profile, obtains GPU ID
  and active lease from durable workload state, takes its own trusted timestamp,
  then uses B2C2B2B's claim writer to revalidate all fields under the shared
  scheduler transaction lock. Concurrent broker callers cannot claim the same
  resource twice. A missing fence row is protected by the shared lock.
- A broker request specifies only `{schemaVersion,subjectKind,subjectId,leaseId,attemptId}`.
  Any `gpuUuid`, `workerId`, `artifactDigest`, `now`, runtime path, approval or
  launch flag added by a caller is rejected rather than trusted.

## Disabled by default

`GPULINK_BROKER_PROFILES_JSON` is optional. If unset, the `/v1/broker/attempts/reserve`
route returns 404 and cannot create claims. If set, it must be a strict JSON
array (1-16 entries), each with **exactly** these keys:

- `brokerId`: unique operator-provisioned principal ID
- `workerId`: exact ID returned from registered worker (not a caller-supplied worker name)
- `projectId`: exact project allowed for this broker
- `token`: unique random 32+-character broker credential, separate from ALL
  existing worker/client/admin tokens and the grant-signing key
- `artifactDigest`: `sha256:<64 lowercase hexadecimal characters>`; operator-approved reference only
- `adapterIdentity`: approved adapter reference
- `runtimePolicyRevision`: approved policy revision reference
- `approvalRef`: approved operator approval reference

The token and approval policy MUST be provisioned privately (for example through
an operator-managed secret injection). **Never place real secrets in Git, examples,
ZIP archives, telemetry or application logs.** Replacing a worker ID requires
updating the operator's broker profile. A static bearer credential alone is not
hardware attestation, identity federation, or authorization to execute; future
work should assess mutual TLS / short-lived workload identities and host peer
binding. Restrict this HTTP endpoint to loopback or a correctly secured TLS
reverse proxy; do not expose bearer credentials on plaintext public networks.

## HTTP contract

`POST /v1/broker/attempts/reserve`

Headers: `Authorization: Bearer <operator-injected broker credential>` and
`Content-Type: application/json`.

Body example (non-secret identifiers only):

```json
{"schemaVersion":1,"subjectKind":"session","subjectId":"session_example","leaseId":"lease_example","attemptId":"attempt_example"}
```

Successful response (HTTP 201):

```json
{"result":{"schemaVersion":1,"attemptId":"attempt_example","fenceEpoch":1,"status":"reserved-not-launchable","canLaunch":false}}
```

Unconfigured 404; bad/missing broker credentials 401; malformed/extra fields
400; denied ownership / duplicate 409; unavailable database 503. No code or
response carries a workload launch token. Job and session broker requests
observe the same control-plane persistence authority.

## Required acceptance and deferred work

1. Guarded source gate must match the accepted 68-path B2C2B2B checkout,
   then verify the expected 75-path result.
2. SQLite tests exercise unauthorized access, request shape, project/worker
   binding, trusted claim metadata, session eligibility, and duplicate races.
3. PostgreSQL must run against a **disposable PostgreSQL 17 database**,
   verifying persisted approval metadata and independent connection contention.
4. Full repository and TypeScript SDK tests must pass with zero skipped
   PostgreSQL cases, and immutable SQL migration hashes must remain unchanged.

**Not yet in scope:** local Unix peer broker integration, replay-safe broker
transport binding, live execution authority, OCI runtime operations, physical
process termination, cleanup attestation, and safe resource release. A reserved
GPU will stay held until a separately reviewed host-cleanup protocol is built.
