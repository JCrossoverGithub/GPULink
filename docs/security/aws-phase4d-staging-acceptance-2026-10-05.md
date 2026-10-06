# AWS Phase 4D Staging Acceptance — 2026-10-05

## Status

**Accepted.**

Phase 4D AWS/K3s staging acceptance is technically complete.

This acceptance does **not** make AWS authoritative production. The transitional
DigitalOcean deployment remains authoritative until Phase 4E production-state
migration, traffic activation, rollback-window acceptance, and final production
acceptance are complete.

## Accepted staging capabilities

Phase 4D established:

- AWS connectivity for the physical RTX 3070 Ti, RTX 3090 Ti, and RTX 4060
  workers;
- fleet-wide diagnostic workload execution;
- real `benchmark.gpu` acceptance on all three physical GPUs;
- heterogeneous scheduling and ineligible-worker rejection;
- drain and resume behavior;
- stale-worker detection, job recovery, and successful reassignment;
- two control-plane replicas in the AWS overlay;
- PostgreSQL advisory-lock scheduler exclusion across replicas;
- concurrent scheduling without duplicate leasing or same-GPU overlap;
- durable PostgreSQL lifecycle events;
- cross-replica SSE delivery backed by PostgreSQL `LISTEN` / `NOTIFY`;
- Kubernetes-native application rollback to a retained immutable image;
- a fresh verified pgBackRest backup immediately before rollback;
- no-build rollback with health/readiness validation;
- sustained staging operation with the full physical worker fleet.

## Application rollback acceptance

The accepted rollback rehearsal:

- began on the accepted immutable control-plane image;
- deployed a traceable immutable rollback candidate;
- reached two Ready control-plane replicas on the candidate;
- required zero active jobs before rollback;
- completed a new successful pgBackRest incremental backup;
- used `kubectl rollout undo` to the captured starting revision;
- rebuilt no image during rollback;
- restored the accepted immutable control-plane digest;
- returned to two Ready replicas;
- caused no regression to workers that were online at the start of the
  application transition;
- ended with zero active jobs.

The candidate and accepted ReplicaSets remained retained in Kubernetes rollout
history.

## Sustained soak acceptance

The final sustained-operation run used project:

`phase4d-soak-1791244229`

Observed UTC interval:

- start: `2026-10-05T23:50:31Z`;
- finish: `2026-10-06T00:18:07Z`.

The run submitted 30 sequential `diagnostic.echo` jobs through the public AWS
control plane.

Results:

- 30 submitted;
- 30 succeeded;
- 30 succeeded on attempt 1;
- 0 retries;
- 0 failures;
- 0 cancellations;
- 30 `job.queued` events;
- 30 `job.leased` events;
- 30 `job.started` events;
- 30 `job.succeeded` events;
- 0 requeue/failure/cancel lifecycle events;
- 3/3 physical workers remained online and undrained;
- 2/2 control-plane replicas remained Ready;
- both control-plane Pod identities remained unchanged;
- no additional control-plane container restarts occurred;
- the PostgreSQL Pod identity remained unchanged;
- no additional PostgreSQL container restart occurred;
- zero active jobs remained after the run.

Sequential soak placement was not a scheduler-fairness test. Twenty-eight jobs
ran on `desktop-3070ti` and two on `jpcmain-3090ti`; the laptop remained online
and healthy throughout. Heterogeneous placement behavior had already been
accepted separately.

No GPU benchmark was repeated for the soak.

## Phase boundary

Phase 4D proves the AWS staging compute fabric and its operational behavior.

Phase 4E remains responsible for:

- final DigitalOcean backup;
- authoritative-write freeze;
- final PostgreSQL production-state capture;
- restoration of that authoritative state into AWS;
- restored-state verification;
- making AWS authoritative;
- reconnecting and verifying the physical worker fleet;
- final real-workload acceptance;
- production traffic activation;
- rollback-window retention;
- final AWS production acceptance;
- DigitalOcean retirement only after acceptance.
