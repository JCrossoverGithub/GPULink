# AWS/K3s Credential Isolation Acceptance

## Status

PASS

## Environment

AWS reference deployment:

- EC2 instance: `i-006d4ff542f893a04`
- K3s node: `gpulink-prod-control-1`
- Kubernetes: `v1.36.4+k3s1`
- ECR credential provider: `v1.36.1`

Credential provider artifact SHA-256:

    090e59c660d2106532a641ba58199f792e4bc076c6ebb238aabab1f1f5eff95c

## Private ECR Pull

A disposable Kubernetes Pod successfully pulled:

    790072401452.dkr.ecr.us-east-1.amazonaws.com/gpulink/postgres-pgbackrest@sha256:ad91f0e6bdb4a3d2d62692709b56df0830ed135abdd05d9f93715602162932c7

The image executed successfully and reported:

- PostgreSQL 17.11
- pgBackRest 2.59.1

The Pod used:

    automountServiceAccountToken: false

No `imagePullSecrets` were configured.

The cluster contained no Secrets of type:

    kubernetes.io/dockerconfigjson
    kubernetes.io/dockercfg

This demonstrates that private ECR authentication is being performed by the
host-side kubelet exec credential provider rather than Kubernetes registry
Secrets.

## Pod AWS Credential Isolation

A dedicated unprivileged test Pod was created with:

- UID/GID 999
- `allowPrivilegeEscalation: false`
- all Linux capabilities dropped
- `RuntimeDefault` seccomp
- no service-account token
- no volumes
- no image pull secret

The Pod contained no AWS credential environment variables.

An IMDSv2 token request to:

    169.254.169.254/latest/api/token

timed out after five seconds with exit code:

    124

The Pod therefore could not obtain an IMDSv2 token.

## Host AWS Identity

At the same time, the EC2 host successfully resolved:

    arn:aws:sts::790072401452:assumed-role/gpulink-production-host/i-006d4ff542f893a04

This proves the intended boundary:

    EC2 host
      AWS instance role: available
      ECR credential provider: available
      AWS API access: available

    Kubernetes Pod
      AWS environment credentials: absent
      service-account AWS credential exchange: absent
      registry credential Secret: absent
      IMDS access: blocked

## IMDS Configuration

Production EC2 continues to use:

    HttpTokens = required
    HttpPutResponseHopLimit = 1

The hop limit must remain `1` unless the workload identity architecture is
explicitly redesigned.

## Acceptance Result

PASS.

The AWS reference deployment can pull private ECR images through the host
identity without exposing AWS credentials or EC2 instance metadata access to
ordinary Kubernetes workloads.
