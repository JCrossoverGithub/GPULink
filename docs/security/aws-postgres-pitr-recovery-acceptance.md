# AWS PostgreSQL PITR Recovery Acceptance

Date: 2026-09-27

## Purpose

This document records acceptance evidence for PostgreSQL point-in-time recovery
(PITR) in the GPULink AWS reference deployment.

The objective was to prove that an operator-selected PostgreSQL restore point
can be recovered accurately from a full pgBackRest backup plus archived WAL
without modifying the production PostgreSQL data volume or production
application state.

This test validates the recovery mechanism. It does not establish a production
RTO or RPO commitment.

## Isolation boundary

The PITR exercise was performed in a disposable Kubernetes Pod.

The validation environment:

- used only `emptyDir` storage for PostgreSQL data and the test pgBackRest
  repository;
- mounted no production PersistentVolumeClaim;
- was not selected by a production Kubernetes Service;
- exposed no TCP listener;
- used a Unix-domain socket for PostgreSQL access;
- used a separate local POSIX pgBackRest repository for the actual PITR
  experiment;
- did not write validation rows to the production database.

The accepted production backup was used only to seed the disposable validation
cluster.

After seeding, the PITR experiment created its own local pgBackRest stanza,
full backup, and WAL archive chain.

## Local PITR baseline

The disposable PITR repository created a full backup:

    20260927-014117F

The backup completed successfully with:

- PostgreSQL 17;
- pgBackRest 2.59.1;
- 29.2 MB database size;
- WAL start and stop segment `000000020000000000000008`.

The local pgBackRest archive check completed successfully before the backup and
reported zero archive failures.

## Restore-point test

The validation database created the following ordered states:

    state A
      |
      v
    named restore point
      |
      v
    state B

Observed WAL positions were:

    state A LSN:             0/90287C8
    named restore point LSN: 0/9028830
    state B LSN:             0/9028900

Both the restore point and state B were contained in WAL segment:

    000000020000000000000009

The WAL segment was successfully archived into the disposable local pgBackRest
repository before recovery began.

This is an important acceptance property: the recovery target and the later
state were in the same WAL segment. Successful recovery therefore required
PostgreSQL to stop replay at the named restore-point record rather than merely
at a WAL-file boundary.

## PITR restore

The disposable PostgreSQL data directory was stopped cleanly and emptied after
confirming again that the validation Pod mounted no production PVC.

pgBackRest restored the local full backup with a named recovery target and
`target-action=promote`.

The successful file restore reported:

    restore size: 29.2 MB
    file count:   1268
    restore time: 4.627 seconds

PostgreSQL then replayed archived WAL from the local POSIX repository and
reported that recovery stopped at the requested named restore point.

Measured PostgreSQL startup/recovery time from the PostgreSQL log was:

    0.469 seconds

The measured restore plus PostgreSQL recovery phases therefore totaled
approximately:

    5.096 seconds

This number is acceptance-test evidence for this small database and environment.
It is not a production RTO or SLA.

## Recovered state

After promotion, the recovered database reported:

    A_before_restore_point: present
    B_after_restore_point:  absent
    in recovery:            false
    archive mode:           off
    TCP listen addresses:   none

The recovered PostgreSQL system identifier matched the source cluster.

This proves that GPULink recovered to the selected named restore point and did
not replay the later committed state.

## Repository isolation finding

The first PITR startup attempt exposed an environment-isolation issue in the
validation Pod.

The Pod still inherited production-oriented pgBackRest environment variables
from its original seed configuration. Those environment variables overrode the
local POSIX repository configuration during `archive-get`, causing pgBackRest
to attempt a remote repository connection.

That attempt failed before recovery could proceed and was not accepted.

For the successful retry:

- scratch PostgreSQL was confirmed stopped;
- scratch PGDATA was reset from the same local full backup;
- the generated recovery command was routed through an environment-scrubbing
  pgBackRest wrapper;
- production-oriented pgBackRest environment variables were removed from the
  PostgreSQL startup environment;
- the successful recovery's `archive-get` commands contained no remote
  repository host;
- all required WAL was read from the disposable local POSIX repository.

This test therefore also established an operational requirement for future
automated PITR tooling: recovery commands must run with an explicitly controlled
pgBackRest environment so deployment-level environment variables cannot
silently override the intended recovery repository.

## Production invariants

During the PITR exercise, production PostgreSQL remained online.

Post-test verification confirmed:

- the production PostgreSQL Pod remained `2/2 Running`;
- the persistence probe row remained present;
- production `archive_mode` remained enabled;
- the PostgreSQL system identifier remained unchanged;
- PostgreSQL reported zero archive failures;
- the production pgBackRest stanza remained healthy;
- the previously accepted off-host full backup remained available.

No production PostgreSQL PVC was attached to the validation Pod and no
production database state was destructively modified.

## Cleanup

The disposable PostgreSQL instance was stopped cleanly.

The validation Pod was then deleted. Because both its PostgreSQL data directory
and local pgBackRest repository used `emptyDir` volumes, deletion removed the
entire disposable PITR database, local backup, and local WAL archive.

No PITR validation Pods remained afterward.

## Acceptance result

Explicit named point-in-time recovery is accepted for the Phase 4 AWS recovery
foundation.

The exercise demonstrated:

- recovery from a full pgBackRest backup plus archived WAL;
- recovery to an operator-selected named restore point;
- transaction-level distinction between state before and after the restore
  point even when both were contained in the same WAL segment;
- promotion of the recovered PostgreSQL cluster;
- isolation from the production PostgreSQL volume and application state;
- local-only WAL retrieval during the accepted recovery attempt;
- successful cleanup of the disposable recovery environment.

Still outside the scope of this acceptance:

- quantifying the production recoverable-data window / RPO;
- defining a production RTO commitment;
- automated recurring restore verification;
- completion of the operator disaster-recovery runbook.
