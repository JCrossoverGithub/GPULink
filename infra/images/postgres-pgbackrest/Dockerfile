FROM postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0

ARG PGBACKREST_PACKAGE_VERSION=2.59.1-1.pgdg12+1
ARG PGBACKREST_EXPECTED_VERSION=2.59.1

LABEL org.opencontainers.image.title="GPULink PostgreSQL"
LABEL org.opencontainers.image.description="PostgreSQL 17.11 with pgBackRest for GPULink"
LABEL org.opencontainers.image.source="https://github.com/JCrossoverGithub/GPULink"

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        "pgbackrest=${PGBACKREST_PACKAGE_VERSION}"; \
    test "$(pgbackrest version)" = "pgBackRest ${PGBACKREST_EXPECTED_VERSION}"; \
    test "$(id -u postgres)" = "999"; \
    test "$(id -g postgres)" = "999"; \
    rm -rf /var/lib/apt/lists/*
