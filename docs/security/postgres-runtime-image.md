# PostgreSQL Runtime Image Security Record

## Status

Accepted as the GPULink Phase 4 PostgreSQL deployment candidate.

Assessment date:

    2026-09-20

The image has not yet been deployed to production.

## Final image

Source commit:

    42a4371e59ee4e646c592f51ed6a3273e6690e12

PostgreSQL:

    17.11

pgBackRest:

    2.59.1

Operating system:

    Debian 13 (Trixie)

AWS reference-deployment ECR index digest:

    sha256:ad91f0e6bdb4a3d2d62692709b56df0830ed135abdd05d9f93715602162932c7

linux/amd64 image manifest:

    sha256:94ce420b4f04b12fedcae88455c7906d8d9169886cfe7bd6ea3d6617e2874ecb

The ECR location is an AWS deployment-profile detail. The image itself does
not depend on ECR, IAM, IMDS, S3, EBS, or another AWS API.

## Image evolution

### Bookworm candidate

PostgreSQL 17.11 on Debian 12 (Bookworm) with pgBackRest 2.59.1.

ECR scan:

    Critical:   4
    High:      24
    Medium:    11
    Low:        1
    Undefined:  1

The image was rejected before production deployment.

Critical findings were associated with Perl and OpenSSL packages in the
Bookworm base.

### Trixie candidate

The runtime moved to Debian 13 (Trixie) while retaining PostgreSQL 17.11 and
pgBackRest 2.59.1.

ECR scan:

    Critical:   0
    High:       9
    Medium:     2
    Low:        2
    Undefined:  1

The move eliminated all Critical findings and materially reduced the High and
Medium findings.

### Hardened Trixie candidate

General-purpose GnuPG executables were removed because they were not required
by the PostgreSQL or pgBackRest runtime.

The scan remained:

    Critical:   0
    High:       9
    Medium:     2
    Low:        2
    Undefined:  1

Inspection showed that gnupg-l10n and gpgconf remained installed from the
gnupg2 source package.

### Final hardened Trixie candidate

The remaining unnecessary gnupg2-family packages were removed.

Final ECR scan:

    Critical:   0
    High:       8
    Medium:     2
    Low:        1
    Undefined:  1

This removed:

    CVE-2026-24882  gnupg2  HIGH
    CVE-2026-57062  gnupg2  LOW

## Remaining High findings

The final eight High findings are:

    CVE-2026-74860  libxml2
    CVE-2026-86138  libxml2
    CVE-2026-86139  libxml2
    CVE-2026-86140  libxml2
    CVE-2026-86142  libxml2
    CVE-2026-86143  libxml2
    CVE-2026-86144  libxml2
    CVE-2026-85091  zlib

libxml2 and zlib are retained because they are runtime dependencies.

pgBackRest dynamically links libxml2 and zlib, and the PostgreSQL package is
built with libxml support.

At assessment time, Debian Trixie does not provide a supported package
containing fixes for the listed libxml2 findings. Debian tracks the relevant
libxml2 fixes in newer distribution packages rather than the Trixie package.

At assessment time, Debian tracks CVE-2026-85091 in zlib as unfixed,
including in unstable.

GPULink does not mix Debian unstable packages into the stable Trixie runtime
solely to reduce scanner counts.

These findings remain tracked and should be reevaluated when supported Trixie
security updates become available.

## Security boundary

The image contains no AWS credentials.

It does not require:

- EC2 Instance Metadata Service;
- an EC2 instance role;
- AWS access keys;
- ECR authentication;
- S3 credentials;
- EBS-specific interfaces.

Cloud-specific identity and storage remain deployment-profile concerns.

For the AWS reference deployment:

- Kubernetes workloads remain unable to access IMDS;
- the EC2 metadata response hop limit remains 1;
- AWS credentials stay at the trusted host boundary;
- ECR authentication is provided by host infrastructure rather than Pod
  credentials;
- PostgreSQL backup cloud credentials remain outside Kubernetes.

## Promotion requirements

Before this image can replace the currently running PostgreSQL image:

1. The deployment environment must be able to pull the immutable image.
2. Kubernetes Pods must remain unable to access IMDS.
3. A verified pgBackRest backup and restore must succeed.
4. The Bookworm-to-Trixie collation migration runbook must be complete.
5. A fresh verified backup must exist before the production image switch.
6. PostgreSQL persistence and existing GPULink data must be verified after
   migration.
