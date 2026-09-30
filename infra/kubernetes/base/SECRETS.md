# GPULink Kubernetes Secret Contracts

## PostgreSQL Authentication

The PostgreSQL workload requires a Kubernetes Secret named:

    postgres-auth

in the `gpulink` namespace.

It must contain:

    password

The real Secret must be provisioned by the deployment environment and must never
be committed to Git.

Example interface only:

    apiVersion: v1
    kind: Secret
    metadata:
      name: postgres-auth
      namespace: gpulink
    stringData:
      password: <deployment-provided-secret>

GPULink application workloads should obtain database credentials from Kubernetes
Secrets rather than embedding credentials in manifests or container images.

## Control-Plane Authentication

The GPULink control-plane workload requires a Kubernetes Secret named:

    control-plane-auth

in the `gpulink` namespace.

It must contain:

    client-token
    worker-token
    admin-token

Each token must contain at least 32 characters. The three token values must be
different.

The real values must be provisioned by the deployment environment and must
never be committed to Git.

Example interface only:

    apiVersion: v1
    kind: Secret
    metadata:
      name: control-plane-auth
      namespace: gpulink
    stringData:
      client-token: <deployment-provided-secret>
      worker-token: <deployment-provided-secret>
      admin-token: <deployment-provided-secret>

## Control-Plane Database Connection

The GPULink control-plane workload also requires a Kubernetes Secret named:

    control-plane-database

in the `gpulink` namespace.

It must contain:

    database-url

For PostgreSQL deployments, `database-url` contains the deployment-local
PostgreSQL connection string consumed by `GPULINK_DATABASE_URL`.

The connection string is deployment material. It must be constructed from the
deployment's PostgreSQL authentication boundary and must never be committed to
Git.

Example interface only:

    apiVersion: v1
    kind: Secret
    metadata:
      name: control-plane-database
      namespace: gpulink
    stringData:
      database-url: <deployment-provided-postgresql-connection-string>
