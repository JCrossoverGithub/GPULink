# AWS PostgreSQL Recurring Recovery Automation Acceptance

Date: 2026-09-27

## Purpose

This document records acceptance evidence for recurring PostgreSQL backup and
restore-verification automation in the GPULink AWS reference deployment.

The objective is to prove that:

- production PostgreSQL backups can be created automatically through the
  existing off-host pgBackRest repository path;
- both full and incremental backup paths function;
- restore verification can consume the newest valid backup chain;
- restore verification uses disposable storage rather than the production
  PostgreSQL volume;
- restored PostgreSQL can complete recovery and satisfy the current database
  validation contract;
- production PostgreSQL remains unchanged throughout the verification.

This acceptance is recovery-validation evidence. Observed durations are not
production RTO guarantees.

## Backup automation

AWS backup creation runs on the repository host through systemd.

The host-side separation preserves the deployment security boundary:

- the repository host owns S3 access through its EC2 instance role;
- Kubernetes database workloads do not receive AWS credentials;
- Kubernetes restore-verification workloads do not receive AWS credentials.

The installed timer runs daily at 02:00 UTC with a randomized delay of up to
15 minutes.

The backup runner selects:

- full backups on Sunday UTC;
- incremental backups Monday through Saturday.

The repository retains two full backup chains through the existing pgBackRest
retention configuration.

## Backup acceptance

The systemd unit definitions passed `systemd-analyze verify`.

A manual systemd execution on Sunday selected the full-backup path and created:

    20260927-102547F

The backup completed successfully and the repository retained the earlier full
backup:

    20260926-235429F

The incremental path was then exercised explicitly and created:

    20260927-102547F_20260927-103505I

The incremental backup referenced:

    20260927-102547F

Both backup paths completed successfully.

After validation, the daily systemd timer was enabled and entered the active
waiting state.

At acceptance time, the next scheduled firing was:

    2026-09-28 02:00:59 UTC

The persistent-timer state was initialized before first activation because the
scheduled time had already passed and a manual acceptance backup had just been
created. This prevented an unnecessary bootstrap catch-up backup while
retaining `Persistent=true` for genuine future missed runs.

## Restore-verification architecture

AWS restore verification is implemented as a Kubernetes CronJob in the AWS
deployment overlay.

The verifier:

- requires its selected backup to satisfy an explicit freshness threshold;
- defaults the AWS weekly verifier to a maximum backup age of six hours;
- has no production PersistentVolumeClaim;
- restores into an `emptyDir`;
- mounts only deployment-local pgBackRest mTLS credentials;
- does not receive a Kubernetes API service-account token;
- receives no AWS credentials;
- accesses the off-host repository through the existing pgBackRest TLS
  repository protocol;
- starts restored PostgreSQL with no TCP listener;
- starts restored PostgreSQL with `archive_mode=off`;
- shuts down the restored PostgreSQL instance;
- explicitly removes restored database contents before successful exit.

The CronJob uses:

    schedule=0 4 * * 0
    timeZone=Etc/UTC
    concurrencyPolicy=Forbid
    activeDeadlineSeconds=1800
    backoffLimit=0

During acceptance testing, the CronJob remained suspended and manual Jobs were
created explicitly from its template.

## Schema-aware validation

Application/control-plane staging has not yet occurred in the AWS database.

At the time of this acceptance, production contained the Phase 4 persistence
probe but did not yet contain:

- `workers`;
- `jobs`;
- `events`;
- `gpulink_schema_migrations`.

The verifier therefore supports two valid states:

1. `0/4` application tables: application schema has not yet been staged;
2. `4/4` application tables: application schema is present and migration
   history must be non-empty.

Any partial state from `1/4` through `3/4` is rejected.

This keeps recovery verification valid during the current infrastructure phase
while automatically becoming stricter once the GPULink application schema is
staged.

## First manual restore attempt

The first automated restore Job successfully:

- selected the newest incremental backup;
- physically restored the backup;
- matched the PostgreSQL system identifier;
- started isolated PostgreSQL;
- replayed required WAL;
- reached a consistent recovery state.

The Job then failed because the initial verifier incorrectly assumed the
application migration table already existed in AWS.

The failure was a validation-policy error rather than a restore failure.

Production PostgreSQL was unchanged.

The verifier was corrected to distinguish the pre-application and
post-application schema states described above.

## Accepted restore-verification run

The accepted manual Job restored:

    20260927-102547F_20260927-103505I

The repository system identifier and restored database system identifier were:

    7687415552174817305

The physical restore completed successfully:

    restore_duration_ms=43752

The isolated PostgreSQL startup and recovery completed in:

    postgres_startup_recovery_ms=2149

Combined restore plus startup/recovery time:

    restore_plus_startup_ms=45901

These timings are acceptance measurements for the current small dataset and do
not define a production RTO.

The restored database reported:

    system_identifier=7687415552174817305
    probe_rows=1
    in_recovery=f
    archive_mode=off
    listen_addresses=
    port=55435
    application_schema_state=not-staged
    application_schema_tables=0/4
    workers_count=not-staged
    jobs_count=not-staged
    events_count=not-staged
    schema_migrations=not-staged

The verifier completed with:

    RESTORE VERIFICATION: PASS
    production_pvc_mounted=false
    tcp_listener_enabled=false
    archive_mode=off
    restore_data_removed=true

The Kubernetes container terminated normally with exit code zero.

## Final freshness-gated acceptance run

After adding the explicit backup-freshness policy, the verifier was exercised
again against the same newest incremental backup chain.

The selected backup was:

    20260927-102547F_20260927-103505I

The verifier measured:

    backup_age_seconds=8018
    max_backup_age_seconds=21600

The selected backup therefore satisfied the six-hour freshness requirement.

The final accepted physical restore completed in:

    restore_duration_ms=40133

Isolated PostgreSQL startup and recovery completed in:

    postgres_startup_recovery_ms=2136

Combined restore plus startup/recovery time:

    restore_plus_startup_ms=42269

The restored database again reported:

    system_identifier=7687415552174817305
    probe_rows=1
    in_recovery=f
    archive_mode=off
    listen_addresses=
    port=55435
    application_schema_state=not-staged
    application_schema_tables=0/4

The final verifier result was:

    RESTORE VERIFICATION: PASS
    production_pvc_mounted=false
    tcp_listener_enabled=false
    archive_mode=off
    restore_data_removed=true

The final Kubernetes Job completed successfully.

An intermediate freshness-gate test failed before restore execution because an
initial multiline Bash parameter expansion was invalid at runtime. The script
was corrected to use a standard single-line parameter expansion and the final
run above passed. Production PostgreSQL was unchanged during that failed
validation attempt.

## Production invariants

Before and after the accepted restore verification:

- the production PostgreSQL Pod UID was unchanged;
- the production PostgreSQL Pod start time was unchanged;
- both production PostgreSQL containers retained zero restarts;
- the production PVC was unchanged;
- the production PV was unchanged;
- the production system identifier remained
  `7687415552174817305`;
- the persistence probe remained present;
- production `archive_mode` remained enabled;
- production `archive_timeout` remained `1min`;
- PostgreSQL reported zero archive failures;
- the pgBackRest repository remained healthy.

The accepted restore-verification Pod did not mount the production PVC.

## Acceptance result

Accepted:

- host-side recurring pgBackRest backup automation;
- successful full-backup execution through the systemd service;
- successful incremental-backup execution;
- enabled daily backup timer;
- Kubernetes restore-verification implementation;
- immutable PostgreSQL/pgBackRest image use;
- disposable `emptyDir` recovery storage;
- no production PVC access by the verifier;
- no Kubernetes service-account token for the verifier;
- successful restore of the newest incremental backup chain;
- successful WAL recovery;
- isolated PostgreSQL startup;
- system-identifier and persistence-probe verification;
- phase-aware application-schema verification;
- explicit restored-data cleanup;
- unchanged production PostgreSQL and persistent storage.

Following repository review and creation of the accepted suspended-state
commit and tag, the weekly restore-verification CronJob was deliberately
activated.

The live schedule is:

    schedule=0 4 * * 0
    timeZone=Etc/UTC
    suspend=false
    concurrencyPolicy=Forbid
    startingDeadlineSeconds=3600

Immediately before activation, four manual restore-verification Jobs existed.
After activation and controller reconciliation, four Jobs still existed and
the before/after Job sets were identical. No unintended catch-up restore was
created.

After activation, production PostgreSQL remained healthy:

    probe_rows=1
    archive_mode=on
    archive_timeout=1min
    failed_count=0
    system_identifier=7687415552174817305

The production PostgreSQL Pod identity and start time remained unchanged and
both production containers retained zero restarts.

At activation time, `lastScheduleTime` was empty because no controller-scheduled
weekly execution had yet occurred. The first naturally scheduled weekly run
therefore remains future operational evidence rather than part of this
activation acceptance.

The remaining Phase 4C recovery work is completion of the operator
disaster-recovery runbook.

## Follow-on application status

This document preserves the database state that existed when recurring recovery
automation was accepted.

Application/control-plane staging subsequently occurred in the AWS database,
including creation of the GPULink application tables and successful
single-replica control-plane staging. The earlier statements above remain
historical evidence of the database state at the time of this recovery
acceptance.
