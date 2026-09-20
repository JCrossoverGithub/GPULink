FROM postgres:17.11-trixie@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232

ARG PGBACKREST_PACKAGE_VERSION=2.59.1-1.pgdg13+1
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
    apt-get purge -y \
        gnupg \
        dirmngr \
        gpg \
        gpg-agent \
        gpgsm \
        gnupg-l10n \
        gpgconf; \
    rm -rf /var/lib/apt/lists/*
