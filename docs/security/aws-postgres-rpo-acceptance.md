# AWS PostgreSQL RPO Acceptance

Date: 2026-09-27

## Purpose

This document records acceptance evidence for the PostgreSQL off-host
recoverability window in the GPULink AWS reference deployment.

The objective was to determine whether WAL generated during low-write periods
had a finite time-based path to the off-host pgBackRest repository, then
configure and measure that behavior.

This acceptance establishes an operational WAL-archival objective. It does not
define a contractual RPO, SLA, or guarantee that every transaction will always
be recoverable within the longest observed test latency.

## Initial condition

Production PostgreSQL initially ran with:

    archive_mode=on
    archive_timeout=0
    wal_segment_size=16 MiB

The repository did not explicitly configure `archive_timeout`.

During the initial low-write observation:

- PostgreSQL remained in the same active WAL segment;
- a named restore-point marker was written into that segment;
- the active segment did not archive during a two-minute observation window;
- `pg_stat_archiver` reported zero archive failures;
- the pgBackRest repository remained healthy.

Because `archive_timeout=0`, PostgreSQL had no time-based WAL-switch threshold
for low-write periods. Off-host recoverability therefore depended on some other
event causing the active WAL segment to switch.

The pre-change configuration was not accepted as a bounded time-based recovery
window.

## Configuration change

The AWS PostgreSQL runtime configuration now sets:

    archive_timeout=60s

The setting is applied alongside the existing:

    archive_mode=on
    archive_command=/etc/pgbackrest/archive/archive-push.sh %p

The production StatefulSet retained the previously accepted immutable
PostgreSQL/pgBackRest image.

After rollout:

- the StatefulSet completed successfully;
- PostgreSQL reported `archive_timeout=1min`;
- `archive_mode` remained enabled;
- the existing archive command remained unchanged;
- the persistence probe remained present;
- the PostgreSQL system identifier remained unchanged.

## Measurement method

The measurement used named PostgreSQL restore points as WAL-only markers.

For each accepted trial:

1. a WAL segment was active;
2. a named restore point was created;
3. its creation timestamp, LSN, and containing WAL segment were recorded;
4. no WAL switch was forced after the marker;
5. `pg_stat_archiver` was polled until that marker's WAL segment became the
   successfully archived segment;
6. marker creation time was compared with `last_archived_time`;
7. `failed_count` was required to remain zero.

Because PostgreSQL's configured `archive_command` synchronously sends WAL
through pgBackRest to the off-host repository path, successful completion of
that archive command was used as the recoverability boundary for this
acceptance test.

A pgBackRest repository check after the trials confirmed that the off-host WAL
frontier had advanced through the tested segments.

## Observed results

Three valid marker-to-successful-archive measurements were recorded:

    trial 1: 21.338 seconds
    trial 2: 23.508 seconds
    trial 3: 38.590 seconds

Observed range:

    21.338-38.590 seconds

All accepted trials reported:

    failed_count=0

The pgBackRest stanza remained healthy after the measurements.

The observed latencies are below the configured 60-second archive timeout
because `archive_timeout` is not a per-transaction timer. WAL segments may
switch for reasons other than the timeout, and a marker may be written into a
segment that has already existed for part of the timeout interval.

## Interpretation

The accepted configuration provides a time-based low-write WAL-switch
threshold of 60 seconds.

This materially changes the recovery behavior from the previous
`archive_timeout=0` configuration, where a low-volume active segment had no
finite time-based switch threshold.

The recoverability path is:

    committed WAL
        |
        v
    active WAL segment
        |
        v
    WAL switch
        |
        v
    PostgreSQL archive_command
        |
        v
    pgBackRest off-host repository

The 60-second value controls the WAL-switch portion of that path.

Actual off-host recoverability also depends on successful completion of
`archive_command`. Repository availability, network conditions, retries, and
other failures can extend the recoverability window.

For that reason, the accepted statement is:

> GPULink configures a 60-second PostgreSQL archive timeout for the AWS
> deployment, and the acceptance test observed successful off-host WAL
> recoverability in 21.338 to 38.590 seconds across three measured trials with
> zero archive failures.

The observed maximum of 38.590 seconds is not treated as a guaranteed maximum
RPO.

## Production invariants

After configuration and measurement:

- the PostgreSQL Pod remained healthy;
- the persistence probe remained present;
- `archive_mode` remained enabled;
- `archive_timeout` reported `1min`;
- the archive command remained the pgBackRest archive-push wrapper;
- the PostgreSQL system identifier was unchanged;
- PostgreSQL reported zero archive failures during the accepted trials;
- the pgBackRest repository remained healthy;
- the off-host WAL frontier advanced through the measured trial segments.

No application-table writes were required for the RPO measurement. Named
restore points were used as WAL markers.

## Acceptance result

The Phase 4 AWS recovery foundation now has an explicit time-based low-write
WAL-switch policy and measured off-host archival behavior.

Accepted:

- `archive_timeout=60s` for the AWS PostgreSQL deployment;
- successful rollout without changing the PostgreSQL system identifier or
  persistence probe;
- three measured marker-to-off-host archive trials;
- observed successful archive latencies of 21.338, 23.508, and 38.590 seconds;
- zero PostgreSQL archive failures during the accepted measurements;
- healthy pgBackRest repository state after the trials.

This acceptance does not define a production SLA or promise that all future WAL
will always reach the off-host repository within 60 seconds.

Remaining Phase 4C recovery work is focused on recurring automated restore
verification and the operator disaster-recovery runbook.
