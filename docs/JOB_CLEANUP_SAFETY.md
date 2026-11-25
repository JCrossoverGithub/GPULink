# DEV-04B1 — Uncertain job execution and GPU cleanup

This is the safety prerequisite for durable custom batch jobs, not their
implementation. It does not activate the broker claim path or introduce a new
execution engine. DEV-04A's installed external session workload remains unchanged.

## Contract

| Transition | Logical job | Resource |
| --- | --- | --- |
| Queued or leased cancellation | cancelled | no new hold (start never accepted) |
| Leased expiry / lost worker before start | existing bounded retry policy | no new hold |
| Running cancellation | cancelled | durable quarantine |
| Running expiry / lost worker | failed, `execution_cleanup_required`, no automatic replay | durable quarantine |
| Ordinary valid finish | existing result/failure contract | existing release behavior |

The existing GPU resource fence table stores the quarantine in the same
transaction as the job transition. SQLite uses its write transaction/savepoint;
PostgreSQL serializes creation and removal with the existing scheduler allocation
lock and row locks. The original job retains its worker, GPU and lease identity
for diagnosis. The scheduler excludes a quarantined job GPU UUID even if the
same device is advertised under another worker identity. Unrelated GPUs remain
eligible. No existing broker attempt/fence is overwritten or released; that
experimental path remains independently governed and non-launchable.

Worker-side job authority checks now compare lease IDs, fail closed on invalid
start/renew acknowledgment, abort on renewal rejection, and enforce a local
monotonic deadline computed from server-relative lease duration less round-trip
latency. Abort does not authorize reporting success or release. The server hold
is needed because worker event loops can stall, networks can partition and GPU
processes can survive logical expiry. This is cooperative stop, not hardware
isolation, proof of process-tree death, or exactly-once execution. Existing
session interruption semantics and normal built-in completion are not redesigned.

## Operator recovery (admin only)

List actual job cleanup holds:

```
gpulink --config-dir SERVER cleanup-holds
```

For an affected worker, drain it using the existing `drain WORKER` command,
stop its GPULink worker and workload processes on the **physical GPU host**,
and verify that no process or descendant from the affected attempt still owns
or can issue work on the GPU. Check the actual device and host process state;
`nvidia-smi` alone is not proof (notably WSL may omit processes). If uncertain,
keep the hold. For trusted private deployments a verified host restart can be
part of an operator cleanup procedure; do not reboot a shared host casually.
Wait until the control plane reports the original worker offline and drained.

Use the exact tuple from `cleanup-holds`:

```
gpulink --config-dir SERVER release-job-hold WORKER GPU EPOCH JOB LEASE --confirm-stopped
```

This is an explicit **operator attestation**, not remotely verified physical
cleanup. The server refuses stale/mismatched epochs, still-online or undrained
workers, active jobs/sessions on that GPU UUID and outstanding broker attempts.
An accepted release is audited as `job.cleanup_operator_confirmed`; it does
not alter the terminal job or automatically replay it. Re-enroll/restart or
resume only after cleanup. This API cannot clear broker-owned fences. Only an
administrator may list or release these holds; ordinary clients/workers cannot.
If the response is lost, re-list holds before any action; do not clear database
rows by hand. Never delete a profile/database to bypass a quarantine.

## Deployment and acceptance boundaries

Upgrade server and workers together while quiescent. Existing databases use the
already-created fence table (no new schema migration). This change is forward
protection, not proof that older cancelled jobs stopped. Do not roll back to
software that lacks this global quarantine behavior while a hold is unresolved.
Legacy SQLite-to-PostgreSQL migration refuses a source containing any non-clear
resource hold because that migration does not transfer execution ownership.
Use a stopped, quiescent source and do not migrate active workload ownership.

Regression gates: SQLite cancellation, expiry, re-enrollment, independent GPU,
pre-start retries, rollback, restart, exact operator recovery and existing broker
holds; worker deadline and agent cancellation; PostgreSQL service test on an
ephemeral CI database (never the operator's real database). Real GPU process
termination/recovery under a long external batch workload remains a DEV-04B
acceptance gate. External batch dispatch, bounded persistent input/output and
its package contract are deliberately not included in this safety change.
