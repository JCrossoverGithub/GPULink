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
