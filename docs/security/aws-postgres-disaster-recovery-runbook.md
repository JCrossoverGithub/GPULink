# AWS PostgreSQL Disaster Recovery Runbook

## Purpose

This runbook defines the operator procedure for recovering the GPULink
PostgreSQL service in the AWS reference deployment after host loss, storage
loss, database corruption, or a logical-data incident.

This runbook is intentionally conservative.

The primary objectives are:

- prevent competing writers during recovery;
- preserve surviving production data before destructive action;
- recover only from a repository state that has been inspected;
- keep AWS credentials outside Kubernetes workloads;
- preserve the existing pgBackRest mutual-TLS trust boundary;
- restore PostgreSQL using the immutable accepted runtime image;
- verify PostgreSQL and GPULink state before allowing application writes;
- preserve a rollback path until recovery has been accepted.

This document does not define a production RTO or RPO SLA.

Measured recovery and WAL-archive times recorded elsewhere in the repository are
acceptance evidence for the tested dataset, not service commitments.

## Scope

This runbook covers the AWS PostgreSQL recovery path.

It does not replace:

- normal Kubernetes Pod restart behavior;
- control-plane release rollback;
- Phase 4D worker and workload acceptance;
- public-traffic cutover procedures;
- post-recovery Terraform reconciliation.

Control-plane rollback and PostgreSQL disaster recovery are separate operations.
Rolling back a control-plane release does not roll back the database.

## Current recovery architecture

The AWS reference deployment separates PostgreSQL persistence and off-host
backup data from the replaceable compute host.

The current reference deployment uses one EC2 host for K3s and the host-side
pgBackRest repository service. The durable pgBackRest repository data is stored
off-host in S3, but loss of the EC2/root volume can also remove the repository
daemon configuration and repository-side TLS material.

Host-loss recovery must therefore restore or reconstruct the repository service
and its deployment-local trust material before PostgreSQL can consume the
off-host backup repository.

The recovery architecture consists of:

- a PostgreSQL StatefulSet named `postgres`;
- a PersistentVolumeClaim named `postgres-data`;
- an AWS-specific PersistentVolume named `gpulink-postgres-data-aws`;
- a dedicated EBS PostgreSQL data volume;
- the host mount point `/var/lib/gpulink/postgres`;
- PostgreSQL WAL archival through pgBackRest;
- S3-backed pgBackRest backup and WAL storage;
- deployment-local pgBackRest mutual-TLS identities;
- host-side AWS credentials through the EC2 instance role;
- daily automated pgBackRest backups;
- weekly isolated restore verification.

Kubernetes PostgreSQL and restore-verification workloads do not receive AWS
credentials.

Deployment-specific repository addresses, AWS resource identifiers,
certificates, private keys, and bucket names are not committed to the public
repository.

## Recovery safety invariants

The operator MUST preserve these invariants throughout recovery.

1. There must be only one authoritative PostgreSQL writer.

2. The production PostgreSQL StatefulSet must not be running while its
   authoritative data directory is being replaced or restored.

3. Application/control-plane writers must remain stopped or otherwise fenced
   until PostgreSQL recovery validation has passed.

4. A surviving production EBS volume must not be formatted, wiped, or reused
   until the operator has deliberately chosen a destructive recovery path.

5. Recovery must not introduce AWS credentials into Kubernetes workloads.

6. pgBackRest traffic must continue to use the deployment's existing mTLS
   trust boundary.

7. A restore must use an immutable PostgreSQL/pgBackRest image accepted for the
   deployment.

8. The recovered PostgreSQL system identifier must agree with the selected
   pgBackRest repository history.

9. Application schema state must be internally consistent. A partially present
   GPULink application schema is not acceptable.

10. Public traffic and application writes must not resume merely because
    PostgreSQL starts. All validation gates in this runbook must pass first.

## Incident classes

Classify the incident before choosing a recovery path.

### A. PostgreSQL Pod or container failure

Examples:

- container crash;
- Pod eviction;
- transient node-local runtime failure while the EBS-backed data remains
  healthy.

This is normally not disaster recovery.

Allow Kubernetes to recreate the Pod and verify database health before taking
more invasive action.

Do not restore from backup merely because a Pod restarted.

### B. Compute-host loss with the PostgreSQL EBS volume intact

Examples:

- EC2 root-volume loss;
- host replacement;
- unrecoverable K3s host failure;
- operating-system failure.

Prefer reattaching and validating the surviving PostgreSQL EBS volume.

Because the pgBackRest repository service is host-side in the current reference
deployment, assume that an unrecoverable host/root-volume failure also requires
reconstruction of that service before backup or WAL operations can resume.

The S3-backed repository data remains the durable off-host recovery source.

Do not perform a pgBackRest restore when the authoritative data volume is known
to be healthy unless there is a separate database-recovery reason.

### C. PostgreSQL EBS volume loss or corruption

Examples:

- volume unavailable or destroyed;
- filesystem corruption;
- PostgreSQL data directory unrecoverable;
- data volume cannot safely become authoritative again.

Recover onto replacement storage from pgBackRest backup plus archived WAL.

### D. Logical database corruption

Examples:

- destructive application write;
- accidental deletion;
- incorrect migration or operator action;
- data corruption where infrastructure remains healthy.

Do not overwrite the surviving production volume as the first response.

Preserve it as rollback/evidence and recover onto replacement storage.

When recovery must stop before known bad state, use an explicitly selected
point-in-time target.

Current GPULink acceptance evidence covers both operator-selected named
PostgreSQL point-in-time recovery and the reviewed one-shot authoritative
restore path exercised against disposable replacement EBS storage.

## 1. Declare recovery and start an incident record

Record at minimum:

    incident start time
    operator
    reason recovery was declared
    known-good time or restore point, if applicable
    current EC2 instance identity
    current PostgreSQL EBS volume identity
    current PostgreSQL Pod identity, if reachable
    current release/commit
    repository state
    chosen recovery path

Do not place credentials, private keys, secret values, or certificate contents
in the incident record.

## 2. Fence writes

If Kubernetes remains reachable, inspect PostgreSQL first:

    kubectl get statefulset postgres -n gpulink
    kubectl get pod -n gpulink -l app.kubernetes.io/name=postgres
    kubectl get pvc postgres-data -n gpulink
    kubectl get pv gpulink-postgres-data-aws

Stop application/control-plane writers using the deployment's current
application resources.

Then stop PostgreSQL before manipulating its authoritative storage:

    kubectl scale statefulset/postgres \
      -n gpulink \
      --replicas=0

Confirm no PostgreSQL Pod remains:

    kubectl get pod \
      -n gpulink \
      -l app.kubernetes.io/name=postgres

Do not continue with storage replacement while a PostgreSQL Pod is still using
the production PVC.

Suspend automated restore verification during the incident:

    kubectl patch cronjob postgres-restore-verification \
      -n gpulink \
      --type=merge \
      -p '{"spec":{"suspend":true}}'

On the repository host, stop the recurring backup timer while authoritative
database state is intentionally offline:

    sudo systemctl stop gpulink-postgres-backup.timer

Do not disable the timer permanently.

## 3. Preserve surviving state

Before detaching, replacing, formatting, or restoring storage, record:

    kubectl get pvc postgres-data -n gpulink -o yaml
    kubectl get pv gpulink-postgres-data-aws -o yaml

Record the deployment's current PostgreSQL EBS volume ID through the approved
AWS/Terraform operational path.

If the existing volume survives, preserve it until recovery is accepted.

For logical corruption, the surviving volume is a rollback and forensic asset.
Do not perform the first recovery attempt in place.

## 4. Inspect the pgBackRest repository

The repository host owns AWS/S3 access.

Do not copy its AWS credentials into a Kubernetes Pod.

Inspect repository state with the deployment's existing pgBackRest
configuration:

    sudo -u pgbackrest pgbackrest \
      --stanza=gpulink \
      info

Review:

- stanza status;
- database system identifier;
- completed full backups;
- completed differential/incremental backups;
- backup timestamps;
- archived WAL range;
- repository errors.

A backup label must be selected deliberately.

For normal infrastructure recovery, select the newest completed valid backup
chain that is consistent with the desired recovery state.

For logical corruption, identify the operator-selected recovery target before
restoring.

Do not treat `pgbackrest check` failure as proof of repository corruption when
the database side has intentionally been taken offline; `check` can require
database-side communication.

## 5. Select the recovery objective

Write the selected objective into the incident record before any restore.

For latest-state recovery record:

    selected backup label
    repository system identifier
    newest archived WAL observed
    reason latest-state recovery is appropriate

For point-in-time recovery record:

    selected backup chain
    selected named restore point
    repository system identifier
    reason the target precedes the known bad state

Do not silently change the recovery target after restore begins.

If the selected target is uncertain, stop and investigate rather than choosing
a target by convenience.

## 6. Choose storage recovery path

### Existing data volume is healthy

For compute-host replacement with healthy database storage:

1. provision or recover the host using the reviewed AWS infrastructure;
2. attach the existing PostgreSQL EBS volume;
3. verify that the attached volume ID is the expected production volume;
4. prepare the mount using the repository storage script;
5. verify the storage marker;
6. restore Kubernetes only after the mount is verified.

The repository provides:

    infra/aws/scripts/prepare-postgres-storage.sh

Its default PostgreSQL mount point is:

    /var/lib/gpulink/postgres

Run the script only with the expected deployment-specific EBS volume ID.

It verifies the attached device, persistent `/etc/fstab` mapping, mount source,
and GPULink storage marker.

Do not substitute an unverified block device manually.

### Existing data volume is lost, corrupt, or intentionally preserved

Provision replacement EBS storage using a reviewed AWS change.

Do not destroy or overwrite a surviving old PostgreSQL volume simply to make
Terraform converge during an incident.

Record the replacement volume ID.

Attach it to the recovery host and prepare it with:

    infra/aws/scripts/prepare-postgres-storage.sh \
      <replacement-volume-id> \
      /var/lib/gpulink/postgres

Verify:

    findmnt -M /var/lib/gpulink/postgres

and verify the GPULink storage marker belongs to the replacement volume.

STOP if the mounted device does not match the intended recovery volume.

## 7. Production pgBackRest restore execution

### Reviewed one-shot recovery primitive

GPULink provides a separate operator-controlled PostgreSQL disaster-recovery
primitive under:

    infra/kubernetes/overlays/aws/recovery/
      run-restore.sh
      restore.sh
      postgres-disaster-restore-job.yaml

These files are intentionally not referenced by the normal AWS kustomization.
They must not become part of routine application deployment.

The weekly restore-verification CronJob remains separate and must continue to
use disposable storage. Do not modify it to mount the authoritative PostgreSQL
PVC.

`run-restore.sh` is the required entry point. Do not apply
`postgres-disaster-restore-job.yaml` directly. Its image and PVC values are
fail-closed sentinels that the wrapper renders only after validating the
operator request.

The wrapper supports separate `acceptance` and `production` scopes.

Before creating recovery resources it validates, at minimum:

- the requested immutable image is digest-pinned and matches the reviewed
  runtime digest;
- the target PVC is `Bound`;
- the bound PV uses the expected GPULink PostgreSQL storage class;
- the PV uses `Retain`;
- the PV local path matches the requested host mount;
- the PV node affinity includes the current Kubernetes node;
- no Pod currently references the target PVC;
- the host block device matches the expected EBS volume identity;
- the mounted filesystem and GPULink storage marker match the expected volume;
- the target `PGDATA` is empty before a new physical restore;
- no previous disaster-restore Job or request ConfigMaps remain;
- the rendered Job passes Kubernetes server-side dry-run validation.

`acceptance` scope additionally refuses the production PostgreSQL PVC, PV, and
mount path.

`production` scope additionally requires all production fencing conditions to
be true before execution:

- the target is the production PostgreSQL PVC/PV/mount contract;
- the PostgreSQL StatefulSet is scaled to zero;
- no production PostgreSQL Pod remains;
- recurring restore verification is suspended;
- the host backup timer is inactive;
- the host backup service is inactive;
- the operator provides the exact confirmation value derived from the intended
  EBS volume and backup label.

The production recovery Job:

- mounts only the selected authoritative storage;
- uses the reviewed immutable PostgreSQL/pgBackRest image;
- mounts deployment-local pgBackRest client TLS material;
- obtains the repository endpoint through deployment configuration;
- receives no AWS credentials;
- exposes no PostgreSQL Service or TCP listener during validation;
- restores only the explicitly selected backup and recovery target;
- validates the repository and restored PostgreSQL system identifiers;
- starts the restored cluster in isolation;
- validates persistence and application-schema state;
- stops the isolated PostgreSQL process cleanly;
- preserves successfully restored authoritative data for operator inspection
  and cutover.

For a latest-recovery production restore, define deployment-local values on the
trusted recovery host:

    RECOVERY_DIR=<path-to-reviewed-recovery-files>
    IMAGE=<immutable-postgres-pgbackrest-image>@sha256:<digest>
    VOLUME_ID=<intended-ebs-volume-id>
    BACKUP_LABEL=<selected-pgbackrest-backup-label>
    SYSTEM_ID=<expected-postgresql-system-identifier>
    SCHEMA_STATE=not-staged

Use `SCHEMA_STATE=present` only after the application schema has actually been
staged and migration history is expected.

First run the wrapper without `--execute`:

    sudo "${RECOVERY_DIR}/run-restore.sh" \
      --scope production \
      --image "${IMAGE}" \
      --target-pvc postgres-data \
      --host-mount /var/lib/gpulink/postgres \
      --expected-volume-id "${VOLUME_ID}" \
      --backup-label "${BACKUP_LABEL}" \
      --expected-system-id "${SYSTEM_ID}" \
      --mode latest \
      --schema-state "${SCHEMA_STATE}" \
      --confirm-production \
        "RESTORE-PRODUCTION-${VOLUME_ID}-${BACKUP_LABEL}"

The required result is:

    DISASTER RESTORE PREFLIGHT: PASS
    No Kubernetes resources were created.

Do not continue if any preflight gate fails.

After reviewing the preflight output, repeat the exact request with
`--execute` added.

For named point-in-time recovery, use `--mode name` and provide the required
named recovery target. The restore implementation applies promotion semantics
only to targeted recovery modes.

The wrapper deliberately does not delete the recovery Job or request ConfigMaps
after execution. Preserve them until recovery logs and evidence have been
reviewed.

Do NOT improvise a destructive `pgbackrest restore` directly against an
authoritative volume.

Do NOT weaken the production fencing checks merely to make a failed recovery
attempt proceed.

## 8. Restore validation gate

After the production recovery primitive completes, do not immediately resume
application traffic.

The one-shot recovery primitive starts the recovered PostgreSQL cluster in
isolation, with no TCP listener and WAL archiving disabled during validation,
then stops it cleanly. Treat `DISASTER RESTORE: PASS` as a prerequisite and
independently review and record the recovery evidence before reconnecting the
application.

Validate:

    PostgreSQL starts successfully
    pg_is_in_recovery() = false
    expected system identifier
    expected database exists
    persistence probe is present
    archive configuration is correct
    pg_stat_archiver reports no new failure condition

After application/control-plane schema has been staged, also validate:

    workers exists
    jobs exists
    events exists
    gpulink_schema_migrations exists
    migration history is non-empty

A partial application schema is a hard failure.

The accepted AWS restore verifier treats `0/4` application tables as the
pre-application-staging state and `4/4` as the staged state.

It rejects every partial state from `1/4` through `3/4`.

Once the application has been staged in production, disaster recovery must
expect the `4/4` state.

## 9. Validate recovery semantics

For latest-state recovery, verify that expected durable GPULink state is
present.

For point-in-time recovery, verify both sides of the recovery boundary:

    known state before target: present
    known state after target: absent

Do not accept a PITR operation based only on PostgreSQL successfully starting.

Validate that the selected logical recovery objective was actually achieved.

## 10. Reconnect the application

Only after database validation passes:

1. restore the normal PostgreSQL StatefulSet configuration;
2. verify the production PostgreSQL Service;
3. start the GPULink control plane;
4. verify control-plane health/readiness;
5. verify database migrations;
6. verify worker registration/reconciliation;
7. verify scheduler behavior;
8. verify event/SSE behavior;
9. run the required staging or production acceptance workload.

Worker re-registration by stable name and normal reconciliation are application
recovery mechanisms, but they do not replace database validation.

## 11. Resume WAL archival and automation

Confirm:

    archive_mode=on
    archive_timeout has the accepted deployment value
    pg_stat_archiver failed_count is not increasing

Confirm new WAL reaches the off-host repository.

Then re-enable/start the backup timer:

    sudo systemctl enable --now gpulink-postgres-backup.timer

Restore the weekly recovery verifier to the repository-defined live state:

    kubectl patch cronjob postgres-restore-verification \
      -n gpulink \
      --type=merge \
      -p '{"spec":{"suspend":false}}'

Verify:

    kubectl get cronjob postgres-restore-verification \
      -n gpulink

Do not declare recovery complete until recurring protection is active again.

## 12. Cutover acceptance

The recovered database may become authoritative only when all applicable gates
pass:

- correct intended recovery target;
- correct PostgreSQL system identifier;
- PostgreSQL out of recovery;
- expected persistence/application data;
- valid application schema state;
- successful migrations;
- WAL archival healthy;
- repository reachable;
- backup automation enabled;
- restore verification enabled;
- control-plane health/readiness passing;
- worker reconciliation passing;
- scheduler/event behavior passing;
- required workload acceptance passing.

A PostgreSQL process being `Ready` is not sufficient by itself.

## 13. Abort criteria

Abort the recovery attempt if any of the following occurs:

- unexpected EBS volume is mounted;
- storage marker identifies a different volume;
- repository system identifier is unexpected;
- selected backup cannot be justified;
- required WAL is unavailable;
- pgBackRest reports repository corruption/error;
- restore targets the wrong recovery point;
- PostgreSQL system identifier does not match the intended repository history;
- PostgreSQL remains in recovery unexpectedly;
- application schema is partial;
- migration history is missing after application staging;
- recovery would require exposing AWS credentials to Kubernetes;
- recovery would require committing deployment TLS material;
- another PostgreSQL writer may still be active;
- operator cannot establish which copy of PostgreSQL is authoritative.

Preserve evidence and investigate rather than weakening an invariant.

## 14. Rollback during recovery

Until recovery is accepted, preserve the previous surviving PostgreSQL volume
whenever possible.

If the recovered replacement volume fails validation:

1. stop recovered PostgreSQL;
2. stop application writers;
3. preserve recovery logs and metadata;
4. detach or otherwise quarantine the failed recovery volume;
5. return to the previous known-safe storage only if that storage is itself
   known to be usable;
6. otherwise select a new recovery target and repeat recovery onto clean
   storage.

Do not alternate between database copies while either may accept writes.

There must always be a single declared authoritative database copy.

## 15. Terraform reconciliation

Emergency recovery can change the relationship between the Terraform state and
the actual authoritative EBS volume.

Do not run an unreviewed `terraform apply` simply to eliminate drift after
manual recovery.

First record:

    old volume ID
    recovered volume ID
    EC2 instance ID
    attachment
    mount point
    recovery commit/release
    recovery timestamp

Then prepare a normal reviewed infrastructure change so Terraform describes
the accepted authoritative storage.

Review the plan before apply.

A Terraform plan that proposes destruction or replacement of the newly
recovered authoritative volume is a hard stop.

## 16. Post-recovery evidence

Record:

    incident start and end time
    incident classification
    original host identity
    original PostgreSQL volume identity
    replacement host identity, if any
    replacement PostgreSQL volume identity, if any
    selected backup
    selected PITR target, if any
    repository system identifier
    recovered PostgreSQL system identifier
    WAL range used
    restore duration
    PostgreSQL recovery/startup duration
    validation results
    migration state
    worker reconciliation results
    workload acceptance results
    rollback decision
    final authoritative volume
    operator

Do not record secret values, private keys, credentials, or certificate private
material.

## 17. Recovery completion

Recovery is complete only after:

- the intended database state is authoritative;
- production PostgreSQL is healthy;
- normal application writes have resumed intentionally;
- WAL archival is healthy;
- backup automation is active;
- weekly restore verification is active;
- workers and workloads have passed the applicable acceptance gates;
- infrastructure drift caused by the incident is scheduled for or has
  completed reviewed reconciliation;
- the incident record contains the required evidence.

## Tested boundaries

The Phase 4 AWS recovery foundation has demonstrated:

- mutually authenticated pgBackRest database/repository communication;
- AWS/S3 credentials remaining outside Kubernetes workloads;
- continuous off-host WAL archival;
- successful full and incremental backup creation;
- naturally scheduled recurring incremental backups;
- isolated physical restore from the off-host repository;
- successful PostgreSQL WAL recovery;
- named point-in-time recovery;
- transaction-level distinction across a named recovery point;
- restore-verification execution without the production PVC;
- phase-aware application-schema validation;
- recurring backup automation;
- recurring restore-verification automation;
- restore-verification activation without an unintended catch-up restore;
- a reviewed one-shot authoritative disaster-restore primitive;
- fail-closed separation between acceptance and production restore scope;
- server-side validation before one-shot recovery resources are created;
- physical restore onto separate disposable replacement EBS storage;
- restore of the selected incremental backup chain from the off-host
  repository;
- restored PostgreSQL system-identifier validation;
- persistence-probe validation;
- application-schema-state validation;
- isolated validation with no TCP listener;
- isolated validation with WAL archiving disabled;
- preservation of successfully restored authoritative data;
- completion of the restore without restarting or replacing the running
  production PostgreSQL Pod;
- full cleanup of the disposable Kubernetes and EBS acceptance resources after
  the test.

These tests validate the underlying recovery mechanisms and the operator
one-shot recovery path.

They do not replace the operator controls in this runbook, do not represent an
actual production-loss incident, and do not establish a production RTO or RPO
SLA.

## Phase 4C acceptance status

On 2026-09-30 UTC, the reviewed one-shot disaster-recovery primitive was
exercised end-to-end against a separately provisioned disposable replacement
EBS volume.

The acceptance test used a separate static local PV/PVC and did not mount,
modify, stop, restart, or replace the production PostgreSQL volume or Pod.

The accepted recovery:

- passed the wrapper's non-executing preflight;
- created only incident-local recovery ConfigMaps and a one-shot Job;
- reached the host-side pgBackRest repository over mutual TLS;
- restored the explicitly selected incremental backup chain;
- recovered the expected PostgreSQL system identifier;
- booted PostgreSQL in isolation;
- returned the expected persistence probe;
- correctly identified the application schema as not yet staged;
- confirmed PostgreSQL was no longer in recovery;
- exposed no TCP listener during validation;
- kept WAL archiving disabled during isolated validation;
- stopped PostgreSQL cleanly after validation;
- preserved the recovered data on the replacement filesystem;
- completed with `DISASTER RESTORE: PASS`.

Throughout acceptance, the production PostgreSQL Pod remained running with the
same Pod identity and zero container restarts.

After acceptance, the one-shot Job, incident ConfigMaps, acceptance PVC/PV,
temporary filesystem mount, temporary `/etc/fstab` entry, and disposable EBS
volume were removed. Production storage and recurring backup automation were
then re-verified.

The disaster-recovery implementation and operator runbook required for Phase
4C are complete in this revision.

Phase 4D fleet-wide worker/workload acceptance, multi-replica application
acceptance, rollback, sustained operation, and Phase 4E production migration
remain separate work and are not implied by Phase 4C completion.

Single-replica control-plane staging, public ingress/TLS, and the first physical
JPCMAIN RTX 3090 Ti workload subsequently received their own acceptance
evidence.
