# GPULink Production Operations

This document describes the current GPULink production deployment and its
operational safety mechanisms.

AWS/K3s is the authoritative GPULink production environment as of 2026-10-13.

Phase 4E migrated the final authoritative PostgreSQL state from the
transitional DigitalOcean deployment into AWS, preserved worker identities and
durable event ordering, reconnected the physical GPU path, and completed a real
CUDA workload through the public AWS production endpoint.

The former DigitalOcean deployment is frozen and retained only as a rollback
target. Its control plane must remain stopped while AWS is authoritative.

## Production topology

The authoritative production control plane runs on AWS/K3s.

The production platform includes:

- Traefik as the public HTTP/HTTPS ingress boundary;
- trusted public TLS with cert-manager certificate management;
- two GPULink control-plane replicas;
- PostgreSQL 17 on dedicated encrypted gp3 storage;
- pgBackRest backup and continuous WAL archival to off-host S3 storage;
- recurring restore verification;
- outbound-only physical GPU workers.

PostgreSQL has no public endpoint.

Physical GPU workers initiate outbound HTTPS connections to the public GPULink
endpoint. GPULink does not require inbound worker listeners on the personal GPU
machines.

The former DigitalOcean host is not an active writer. Its control plane remains
stopped and the retained state exists only for migration rollback.

## Sensitive configuration

Production credentials are stored outside the repository:

- `/etc/gpulink/control-plane.env`
- `/etc/gpulink/postgres.env`

These files are root-controlled and must never be copied into source control,
logs, documentation, or issue reports.

The installer preserves existing production credentials on reruns.

## Release identity

Every modern production release is derived from a Git commit.

The source archive contains an expanded `RELEASE_REVISION`.

The control-plane image is tagged with the first 12 characters of that revision
and includes OCI labels for:

- source repository;
- full revision;
- release version.

The installed source revision is recorded in
`/opt/gpulink/RELEASE_REVISION`.

The control-plane revision actually running is recorded separately in
`/opt/gpulink/DEPLOYED_CONTROL_PLANE_REVISION`.

These values normally match. They intentionally differ during a controlled
rollback because the installed operational tooling remains on the newer release
while the control plane runs a retained older image.

## Deployment

Production deployment uses
`scripts/install-control-plane-docker.sh`.

The installer:

- validates the existing PostgreSQL configuration before changing deployment
  state;
- refuses unsafe automatic mutation of an existing SQLite production
  configuration;
- preserves existing credentials;
- starts and validates PostgreSQL;
- verifies or builds the immutable control-plane release image;
- verifies OCI release identity;
- recreates only the control plane when appropriate;
- waits for control-plane health;
- records the deployed revision;
- installs and enables backup and restore-verification timers.

Deploy and rollback operations share the lock:

`/run/lock/gpulink-control-plane-deploy.lock`

This prevents a normal deployment and rollback from modifying the running
control plane concurrently.

## Health checks

Host-local health endpoints are:

- `http://127.0.0.1:8088/healthz`
- `http://127.0.0.1:8088/readyz`

Expected responses are equivalent to:

`{"status":"ok"}`

and:

`{"status":"ready"}`

## PostgreSQL backup

The backup implementation is
`scripts/backup-postgres.sh`.

The systemd units are:

- `gpulink-postgres-backup.service`
- `gpulink-postgres-backup.timer`

The timer runs daily.

Completed backups are stored under:

`/var/backups/gpulink/postgres/backup-<UTC timestamp>`

A committed backup contains:

- `gpulink-postgres.dump`
- `gpulink-postgres.dump.sha256`
- `pg_restore-list.txt`
- `database-counts.txt`
- `metadata.txt`

The backup is not committed to its final directory until:

- `pg_dump` succeeds;
- the SHA-256 checksum is generated and rechecked;
- `pg_restore --list` can read the dump;
- database-state metadata is captured.

Backup retention applies only to completed `backup-*` directories.

Incomplete backup directories are never interpreted as valid backups.

## Restore verification

Creating a backup is not sufficient evidence of recoverability.

GPULink therefore performs a full restore verification using
`scripts/verify-postgres-restore.sh`.

The systemd units are:

- `gpulink-postgres-restore-verification.service`
- `gpulink-postgres-restore-verification.timer`

The timer runs weekly.

The verifier:

1. selects the newest completed backup;
2. verifies its checksum;
3. identifies the exact PostgreSQL image used by production;
4. starts a disposable container from that image;
5. gives the disposable container no Docker network;
6. verifies that it is not using the production PostgreSQL volume;
7. waits for the final PostgreSQL PID 1 server rather than the image's
   temporary initialization server;
8. creates a disposable restore database;
9. restores the production dump;
10. compares restored worker, job, event, and status counts with the values
    captured during backup;
11. verifies required tables and migration history;
12. verifies that the production PostgreSQL container was not replaced or
    restarted;
13. removes the disposable container and anonymous data volume.

The production restore-verification service has been exercised successfully.

## Controlled rollback

The rollback implementation is
`scripts/rollback-control-plane-docker.sh`.

It requires a full 40-character Git revision.

Rollback is intentionally conservative.

It:

- accepts only traceable releases containing valid `RELEASE_REVISION` metadata;
- refuses legacy or untraceable releases;
- requires the immutable target image to already exist;
- never builds an image during rollback;
- verifies image revision and version OCI labels;
- verifies the currently running release;
- obtains the shared deployment lock;
- refuses to proceed while queued, leased, or running work exists;
- starts and validates a pre-rollback PostgreSQL backup;
- switches only the control-plane image;
- validates container health and the health/readiness endpoints;
- restores the previous control-plane release automatically if target
  validation fails;
- records the deployed revision only after successful acceptance.

A real production rollback and forward restore have both been exercised while
the PostgreSQL container ID, start timestamp, and durable job state remained
unchanged.

### Database compatibility

Control-plane rollback does not roll back the PostgreSQL database.

An older application release must therefore be known to remain compatible with
the current database schema before it is selected as a rollback target.

## Release retention

Traceable release retention is implemented by
`scripts/prune-control-plane-releases.sh`.

The default retained traceable-release count is five.

The pruning logic always protects:

- the currently installed release;
- the currently deployed control-plane release.

Legacy release artifacts are not interpreted as valid rollback targets.

## Current recovery boundary

The authoritative AWS backup and restore system provides the accepted
production recovery boundary.

Production PostgreSQL uses S3-backed pgBackRest backup, continuous WAL
archival, isolated restore verification, recurring recovery automation, and
named point-in-time recovery.

The frozen DigitalOcean environment is retained only as an additional migration
rollback asset while the rollback window remains open.

## Worker safety boundary

Personal GPU workers connect outward to the public control plane.

No GPULink inbound listener is required on the GPU computers.

Workers execute explicit, allowlisted workload implementations rather than
arbitrary remote commands or arbitrary containers.

## Historical deployment documentation

The original [First Operational Target](FIRST_OPERATIONAL_TARGET.md) describes
the first physical-fleet deployment and acceptance process.

It is preserved as engineering history and may still be useful for individual
worker-enrollment details, but its SQLite-era production architecture is no
longer authoritative.

For current architecture and direction, use:

- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- this document.
