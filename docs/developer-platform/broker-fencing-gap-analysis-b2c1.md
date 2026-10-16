# GPULink B2C1 — Existing source to broker authority gap inventory

| Responsibility | Actual source state (2026-10-15 snapshot) | Required future gate |
|---|---|---|
| Current session lease | `sessions.lease_id`, `lease_expires_at`, `assigned_worker_id`, `assigned_gpu_uuid`; session status | B2C1 observes; B2C2 adds transactional reservation |
| Lease generation | Not an explicit persisted column | B2C2 durable generation migration, CAS/rollover tests |
| GPU allocation | Whole-GPU scheduling + exclusive job/session behavior | B2C2 attempt-specific reservation bound to lease/generation |
| Attempt ledger | B2B broker-owned SQLite journal | B2C2 authority-side reservation and restart reconciliation |
| GPU device mapping | Worker advertises UUID, broker test fixture lists arbitrary deviceIds | Later host/runtime broker must map opaque UUID from approved host inventory |
| Artifact/operator policy | B2A/B2B fixture-only imageDigest and profileId | Operator-owned approval/policy authority + revision binding |
| Broker authentication | B2B `SO_PEERCRED` test-only UID | Distinct OS principal + independent service credential and scoped control-plane permissions |
| Revocation/expiry | Control plane updates leases, broker fixture does not subscribe | Authenticated invalidation / bounded reconciliation + final launch gate |
| Durability/backends | SQLite and PostgreSQL persistence contracts | Both providers must implement all B2C2 migrations and transactional uniqueness |
| Adapter execution | DP3C3A subprocess + B1 fake runtime only | Host-isolated OCI backend separately reviewed, no unsafe fallback |

## B2C2 atomic reservation sketch — NOT EXECUTABLE CODE

1. Authenticate broker service identity (not inherited worker API token); validate exact request identity.
2. In one authority-controlled transaction, compare current lease ID **and persisted generation**, expiry, worker, GPU, session state, artifact approval, runtime policy revision, and zero conflicting GPU reservations.
3. Insert a unique pending attempt reservation, with a monotonic fence token/revision and bounded expiry; commit the authoritative record before returning an opaque, short-lived broker-scoped capability.
4. Revalidate the reservation/fence immediately before host workload creation, and enforce a definitive terminal state or cleanup if authorization changes. The host mechanism must not allow stale work to continue indefinitely during partitions.
5. Crash/restart recovery quarantines/terminates orphaned attempts; reconciles both authority and engine state; never infers success from exit alone.

This outline is not enough by itself to guarantee atomicity between two independent services. In particular, no database transaction can roll back a privileged kernel/container operation. Correctness requires fencing, idempotent resource creation, bounded leases, and tested reconciliation at both boundaries.

## Required negative tests before live launch

Concurrent claims for one GPU; stale-generation replay; reservation competing with lease close/reassignment; worker UID impersonation; duplicate attempt across broker restart; crash between reserve/prepare/start; revocation during start; auth-provider outage; mismatched OCI image digest; missing GPU/control-profile enforcement; worker request injection; active workload surviving revoked authority; isolated request falling back to trusted subprocess; new schema compatibility and rollback for both persistence providers.

**Do not claim multi-tenant untrusted code support or production isolation until separately certified.**
