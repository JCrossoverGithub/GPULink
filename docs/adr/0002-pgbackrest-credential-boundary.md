# ADR 0002: Keep Backup Cloud Credentials Outside Kubernetes

## Status

Accepted

## Context

GPULink production PostgreSQL runs inside K3s while the initial AWS
deployment uses an EC2 instance role for infrastructure-level AWS access.

A proposed design increased the EC2 IMDSv2 response hop limit from 1 to 2
and attempted to use Kubernetes NetworkPolicy to allow metadata access only
from PostgreSQL.

Production testing disproved that isolation assumption.

With the EC2 metadata hop limit set to 2, an ordinary GPULink Pod was able
to reach the EC2 Instance Metadata Service despite a NetworkPolicy intended
to exclude 169.254.169.254.

The design was rolled back.

With the metadata hop limit restored to 1:

- ordinary Kubernetes Pods cannot use IMDS;
- the EC2 host can still use its instance role;
- PostgreSQL remains healthy;
- Terraform reports zero infrastructure drift.

Backup architecture must preserve this security boundary.

## Decision

GPULink Kubernetes workloads must not require access to the EC2 Instance
Metadata Service.

The EC2 metadata response hop limit remains:

    1

AWS credentials used for PostgreSQL backup and WAL archival remain outside
the Kubernetes workload boundary.

The AWS production reference architecture will use pgBackRest's dedicated
repository-host model.

### Database side

The PostgreSQL workload will contain:

- PostgreSQL;
- pgBackRest;
- pgBackRest configuration for the GPULink stanza;
- mutually authenticated TLS material required to communicate with the
  repository host.

The PostgreSQL workload will not contain:

- AWS access keys;
- AWS secret access keys;
- EC2 instance-role credentials;
- access to IMDS;
- permission to retrieve the EC2 instance role.

### Repository side

The EC2 host will run the pgBackRest repository service.

The repository service may:

- use the EC2 instance role;
- access the GPULink PostgreSQL backup bucket;
- receive pgBackRest protocol traffic over mutually authenticated TLS;
- store backups and archived WAL in the configured object repository.

The repository service must not expose AWS credentials to the PostgreSQL
workload.

### Authentication

Communication between the PostgreSQL workload and the pgBackRest repository
host will use pgBackRest TLS authentication.

Certificate material used by the PostgreSQL workload is application
authentication material, not a cloud credential.

### Versioning

The database-side and repository-side pgBackRest versions must be pinned to
the same release.

The initial production baseline is:

    pgBackRest 2.59.1

Version upgrades must update both sides together.

## Portability

The GPULink Kubernetes base must depend only on the pgBackRest repository
contract.

It must not require:

- AWS IAM;
- EC2 instance metadata;
- AWS access keys;
- an AWS-specific Kubernetes identity mechanism.

The AWS deployment profile may configure an S3 repository and host-level AWS
authentication.

Other deployment profiles may provide:

- S3-compatible object storage;
- another supported pgBackRest repository;
- another cloud identity mechanism;
- self-hosted backup storage.

## Rejected Designs

### IMDS hop limit 2 plus Kubernetes NetworkPolicy

Rejected because production testing demonstrated that an ordinary Pod could
still reach IMDS.

### Static AWS access keys in Kubernetes Secrets

Rejected because long-lived cloud credentials would unnecessarily enter the
Kubernetes workload boundary.

### Making AWS IAM part of the portable Kubernetes base

Rejected because it would violate GPULink's cloud-portability architecture.

## Consequences

Positive:

- Kubernetes workloads do not receive the EC2 instance role.
- IMDS hop limit 1 remains an effective workload isolation control.
- AWS credentials remain at the trusted host boundary.
- PostgreSQL backup configuration remains portable.
- S3 access remains centrally controlled by IAM.

Tradeoffs:

- pgBackRest must run on both the PostgreSQL side and repository side.
- Mutual-TLS certificates must be provisioned and rotated.
- Both pgBackRest installations must remain version-compatible.
- The production image must include pgBackRest in addition to PostgreSQL.
