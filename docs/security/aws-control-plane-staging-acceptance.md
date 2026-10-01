# AWS Control-Plane Staging Acceptance

## Status

PASS

Acceptance date:

    2026-09-30

## Scope

This record covers the first GPULink control-plane staging deployment on the
AWS/K3s reference environment.

This acceptance does not represent:

- public ingress acceptance;
- production traffic cutover;
- multi-replica control-plane acceptance;
- physical GPU-worker acceptance against the AWS control plane;
- production migration from the transitional DigitalOcean environment.

The accepted topology uses one control-plane replica on the existing K3s host.

## Accepted Control-Plane Artifact

The accepted private ECR artifact is:

    <aws-account-id>.dkr.ecr.<region>.amazonaws.com/gpulink/control-plane@sha256:03c5bbdf5487f11abe020cad800192c3ca28c337ede958333bc2be6ac1e18fc5

The Git-derived ECR release tag was independently resolved to the same immutable
digest before deployment.

A disposable Kubernetes Pod then pulled and executed the accepted digest through
the host-side ECR credential provider.

Artifact acceptance verified:

- the image could be pulled from private ECR without an `imagePullSecret`;
- the running image ID contained the accepted digest;
- the container executed as UID/GID 1000;
- the required control-plane runtime files were present;
- the disposable test Pod was removed after acceptance.

## ECR Credential-Provider Scope

The initial control-plane pull exposed that the installed kubelet exec
credential-provider configuration matched only the PostgreSQL ECR repository.

The reusable provider configuration was extended to include:

    *.dkr.ecr.*.amazonaws.com/gpulink/control-plane

The PostgreSQL repository scope remained present.

The provider binary itself did not require replacement. Direct provider
validation confirmed that the EC2 instance role could obtain private ECR
credentials for the control-plane repository.

After the configuration change and one K3s restart:

- the node returned Ready immediately;
- the PostgreSQL Pod identity was preserved;
- the PostgreSQL container restart count remained zero;
- the persistence probe remained intact;
- the control-plane private image pull succeeded.

The source checkpoint for this correction is Git commit:

    9ebf179 Fix ECR credential scope for control-plane pulls

## Render Acceptance

The AWS Kubernetes overlay was rendered using immutable PostgreSQL and
control-plane image references.

The render verified:

- every GPULink image reference was digest-pinned;
- the accepted control-plane digest appeared exactly once;
- the committed `registry.invalid` image sentinel was fully replaced;
- no unresolved GPULink image sentinel survived;
- the required Kubernetes Secret references were present.

Only resources carrying:

    app.kubernetes.io/name=control-plane

were selected for the first control-plane apply.

The existing PostgreSQL workload and recovery resources were therefore not
intentionally reconciled by the control-plane deployment operation.

## Secret Contract

Before deployment, the `gpulink` namespace contained:

    control-plane-database
      database-url

    control-plane-auth
      client-token
      worker-token
      admin-token

The three authentication tokens were validated as:

- present;
- at least 32 characters;
- mutually distinct.

The staging values were not printed or recorded in this acceptance document.

The database URL was validated structurally without printing its password.

It resolved the control plane to the in-cluster PostgreSQL Service and the
`gpulink` database.

## Pre-Deployment Database State

Before the first control-plane start:

- the PostgreSQL Pod was Running;
- the PostgreSQL container restart count was zero;
- the only public table was `gpulink_persistence_probe`;
- the persistence probe contained exactly one row;
- `workers`, `jobs`, and `events` were absent.

This proved that application migrations had not already been applied.

## First Deployment

The first server-side dry run accepted both:

    service/control-plane
    deployment.apps/control-plane

The real apply then created those two resources.

The Deployment completed rollout successfully with:

    desired replicas:   1
    updated replicas:   1
    ready replicas:     1
    available replicas: 1

The resulting control-plane Pod was:

- Running;
- Ready;
- at zero container restarts;
- using the accepted immutable control-plane digest.

The Service contract was:

    type: ClusterIP
    port: 8088

The Service had exactly one ready EndpointSlice address.

## Health and Readiness

Direct in-container HTTP acceptance returned:

    GET /healthz
    HTTP 200
    {"status":"ok"}

and:

    GET /readyz
    HTTP 200
    {"status":"ready"}

The corrected HTTP acceptance was repeated after deployment while confirming
that:

- the Pod remained Ready;
- the restart count remained zero;
- the accepted immutable image remained running.

## PostgreSQL Migration Acceptance

First control-plane startup initialized the application schema.

The exact accepted public table set became:

    events
    gpulink_persistence_probe
    gpulink_schema_migrations
    jobs
    workers

The persistence probe remained present with exactly one row.

`gpulink_schema_migrations` is an intentional control-plane migration ledger.
Its accepted contents were:

    filename: 0001-initial.sql
    rows:     1

The recorded migration checksum was:

    f7d03ce4ff89933e8a9f20b65d6bd3191f0d5709aa7cf9e47d49e4948ce971d9

That checksum exactly matched the committed:

    src/control-plane/persistence/migrations/postgres/0001-initial.sql

Immediately after initial deployment:

    workers rows: 0
    jobs rows:    0
    events rows:  0

The PostgreSQL Pod remained stable with zero container restarts throughout the
control-plane deployment and acceptance process.

## Runtime Signal

The control-plane log reported successful PostgreSQL-backed startup:

    {"event":"control_plane_started","address":"0.0.0.0","port":8088,"database":"postgres"}

No credential values were included in the log or acceptance evidence.

## Acceptance Result

PASS.

The AWS/K3s reference environment now has an accepted single-replica GPULink
control-plane staging deployment backed by the existing PostgreSQL workload.

The acceptance proves:

- private ECR delivery of the immutable control-plane artifact;
- source-controlled ECR credential-provider scope;
- Kubernetes Secret contract availability;
- successful control-plane rollout;
- health and readiness;
- ClusterIP service discovery;
- correct PostgreSQL migration initialization;
- migration checksum integrity;
- preservation of the existing persistence probe;
- PostgreSQL runtime stability during deployment.

Still outside this acceptance boundary are public ingress/TLS, multi-replica
control-plane behavior, physical GPU-worker enrollment, real GPU workloads,
staging rollback, sustained operation, and production cutover.
