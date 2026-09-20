# GPULink PostgreSQL + pgBackRest Image

This image extends the exact PostgreSQL image used by GPULink production and
adds a pinned pgBackRest installation.

## Versions

PostgreSQL:

    17.11

Base image:

    postgres:17.11-trixie
    sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232

pgBackRest:

    2.59.1

Debian package:

    2.59.1-1.pgdg13+1

## Security boundary

This image does not contain AWS credentials and does not require access to
EC2 Instance Metadata Service.

Cloud credentials remain outside the Kubernetes workload boundary as defined
by ADR 0002.

The database-side pgBackRest process will communicate with a dedicated
pgBackRest repository service over authenticated TLS.

## UID/GID contract

The PostgreSQL runtime user is expected to remain:

    UID 999
    GID 999

The image build verifies this contract.

## Build

From the repository root:

    docker buildx build \
      --load \
      -t gpulink-postgres-pgbackrest:17.11-2.59.1 \
      infra/images/postgres-pgbackrest

## Verification

    docker run --rm \
      --entrypoint /bin/sh \
      gpulink-postgres-pgbackrest:17.11-2.59.1 \
      -ec '
        postgres --version
        pgbackrest version
        id postgres
      '

The production Kubernetes manifest must eventually reference an immutable
registry digest rather than this local tag.

## Runtime hardening

General-purpose GnuPG tooling is removed after package installation because
the PostgreSQL/pgBackRest runtime does not require it.

This reduces unnecessary runtime attack surface while retaining the packages
required by PostgreSQL, pgBackRest, and apt package verification.

The production image intentionally retains libxml2 and zlib because they are
runtime dependencies. Vulnerabilities without a supported Debian Trixie fix
are tracked separately rather than addressed by mixing packages from Debian
unstable.
