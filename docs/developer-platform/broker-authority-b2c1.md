# GPULink DP3C3B2C1 — Source-backed lease observation (NON-LAUNCH)

Status: **candidate for JPCMAIN acceptance**. 2026-10-15.

## Engineering purpose

GPULink is a reusable multi-language open-source compute platform. Client SDK consumers need no Linux, WSL, local GPU, Docker, or broker. The privileged broker is operator infrastructure only. B2C1 does not pick an OCI engine, vendor, or host platform and adds no Client SDK dependency.

B2B provided a Linux test broker with `SO_PEERCRED` and a SQLite attempt journal, using **synthetic** authority fixtures. Source review of the *actual* control plane identified a schema mismatch: `session.leaseId`, `session.leaseExpiresAt`, `session.assignedWorkerId`, `session.assignedGpuUuid`, `session.status`, `session.interruptionCount` are persisted; **B2A/B2B `leaseGeneration` and `reservationId` are NOT persisted authoritative resources**. Interruption count is not a general-purpose lease generation. The broker must not invent or receive them as worker-supplied truth.

B2C1 adds `src/control-plane/broker-authority-observation.mjs`, which uses the existing Promise-based `persistence.transaction` API to read actual persisted control-plane records (SQLite now; no new database provider code). It validates an **exact bounded query** for session ID, lease ID, worker ID, and GPU UUID. It then verifies all of the following inside a transaction:

1. The recorded session is allocated/connecting/active and belongs to the expected current lease, worker, and GPU; the lease has not expired.
2. The worker exists, is online and not drained; its heartbeat is fresh; its GPU inventory includes exactly one matching UUID.
3. No other occupying session and no leased/running job already claims that same worker/GPU pair.
4. DB provider methods exist and succeed; malformed inputs or provider errors fail closed with bounded error codes.

The result is `status:'observed-current-not-fenced'`, `observationOnly:true`, `generationVerified:false`, `attemptReservationVerified:false`, **`canLaunch:false`**. It is NOT a signed token, not exported to third-party clients, not a broker connection, not durable proof and not permission for container launch.

### Critical TOCTOU limitation

This is a read transaction, **not** a transactionally committed attempt reservation. An authoritative lease can change immediately after its observation. SQLite `BEGIN IMMEDIATE` serializes writers during this brief read; it does not prevent later lease replacement. PostgreSQL transaction isolation may differ; PostgreSQL B2C1 conformance has not been executed. Neither backend may treat this observation as launch permission.

### No changes to existing sessions, scheduler, authentication, or IPC

No existing GPULink source is modified. Worker and broker IPC paths remain unchanged. DP3C3A END/exit/completion ACK is preserved. The root regression suite and SDK tests are required on JPCMAIN.

## B2C2 — needed for independently authenticated live broker authority

This is a **separate migration/design gate** that must be completed before launch-authorizing operations exist.

- Persist a monotonic `leaseGeneration` with each session; increment it atomically on replacement. Do not derive it from `interruptionCount` or timestamps.
- Add an authoritative attempt/reservation record to the SAME control-plane persistence transaction domain as the current lease and GPU assignment. Define `attemptId`, `reservationId`, worker ID, session ID, lease ID, lease generation, GPU UUID, approved artifact digest, runtime profile, expiration and terminal state; enforce unique active reservation policy and referential lifecycle.
- Use transactional compare-and-swap to bind exactly one attempt to a current lease. A stale/expired/replaced lease must not reserve. Race tests must exercise reservation vs. close, revoke, renewal, reassignment and worker loss on SQLite and PostgreSQL.
- Define independently authenticated broker-to-control-plane authority requests with separate service principal/scope; the worker cannot supply authority snapshots. Credentials and certificates are provisioned out of band and never stored in the public repo. A Linux UID alone is not enough when processes share an account.
- Bind artifact approval and runtime isolation policy to the reservation, operator-owned and immutable. Do not permit raw devices, commands, host paths or OCI socket names in a workload request.
- Before an actual launch, perform a final fenced authorization in the authoritative domain. Define behavior on broker reboot, partition, clock uncertainty, revocation and stalled starts. Continuous revocation and cleanup require a later host-execution gate. A one-time validation is not sufficient.
- Move through migration, contract, broker IPC integration and adversarial tests with launch authority **still false**, then review the host-enforced OCI backend separately.

## B2C1 acceptance tests

`test/broker-authority-observation.test.mjs` tests **real SQLite persisted** session and worker records: valid allocated/connecting/active reads, immutable nonlaunch response, wrong lease/worker/GPU, expiry boundary, closed state, offline/drained/stale worker, GPU inventory disappearance, duplicate session occupancy, job conflict, unexpected request fields/getters, missing DB authority, and post-read revocation. It does not substitute or promote B2B synthetic fixtures.

Run the new test on JPCMAIN, along with B2B/B2A/B1 tests, DP3C3A subprocess+IPC regressions, root suite and packed Client SDK. PostgreSQL tests (historically 22 skips without `GPULINK_TEST_POSTGRES_URL`) remain a distinct outstanding gate.

## Source provenance and limits

B2C1 was built against the accepted 2026-10-15 123-file exact-source snapshot plus accepted B1/B2A/B2B five/four/five file additions. The baseline remains JPCMAIN's **47 uncommitted paths**. Guarded application only appends this package's four files for an expected **51-path** worktree. No pushes, commits, resets, installations, containers, actual GPU inference or deployments.
