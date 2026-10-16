# DP3C3B2C2B1 — Inert execution ownership schema (candidate)

Status: pending JPCMAIN acceptance. **No broker authority, execution permission, scheduler fencing, or GPU cleanup certification.**

This stage adds `gpu_resource_fences` and `execution_attempts` storage under the existing SQLite and PostgreSQL schemas. It deliberately creates **zero fence rows** on installation/upgrade, because a previously assigned GPU cannot be declared physically clear from a migration. No new public APIs or persistence methods are added and the production scheduler/worker behavior remains unchanged. DO NOT enable managed execution against these tables.

The primary owner remains the existing jobs/sessions lease. The fence row is a future per-(workerId,gpuUuid) safety hold, not a replacement allocator. Execution attempts are immutable identity-bound records. The unique partial index prevents two *nonterminated* attempts for the same device but does not establish that a terminated process actually exited or that an operator is authorized to change the row. The application layer must later enforce all transitions, verify exact leases, authenticate broker evidence, and coordinate every writer in one transaction.

Design decisions still open: confirmed cleanup evidence, host reboot and GPU UUID stability, managed vs trusted mode registration, broker service authentication, and how to quarantine legacy allocations during opt-in. PostgreSQL initialization applies each immutable SQL migration under its checksum/advisory migration lock. Never modify `0001` or `0002`; review production migrations and back up before use. Schema tests must use an isolated disposable PostgreSQL database.

## Required next gate (B2C2B2)

1. Add transactional fence/attempt methods to both persistence implementations with common contract and strict identity preconditions; resource-row locking on PostgreSQL and cross-connection SQLite constraints.
2. Integrate scheduler allocation, recovery, cancellation, close, and job completion so no managed path bypasses the fence; preserve legacy trusted-only semantics.
3. Add race tests with separate PostgreSQL connections, rollback, lease replacement, expiry/cleanup quarantine, and restart durable replay; fail full acceptance when PostgreSQL is unavailable.
4. Independently authenticate broker calls and verify launch-time authorization in B2C2C; never treat storage constraints as permission to launch.

Stage B2C2B1 is intentionally only the **migration and constraint foundation**, not the full B2C2B acceptance gate.
