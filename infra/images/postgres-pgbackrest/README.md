# GPULink PostgreSQL + pgBackRest Image

This image extends the exact PostgreSQL image used by GPULink production and
adds a pinned pgBackRest installation.

## Versions

PostgreSQL:

    17.11

Base image:

    postgres:17.11-bookworm
    sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0

pgBackRest:

    2.59.1

Debian package:

    2.59.1-1.pgdg12+1

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
