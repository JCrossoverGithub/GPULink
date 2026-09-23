# GPULink AWS ECR Credential Provider

This directory configures private ECR image authentication for the GPULink AWS
reference deployment.

It is intentionally AWS-specific.

The portable Kubernetes base does not depend on this provider.

## Architecture

K3s kubelet
    |
    | exec
    v
ecr-credential-provider
    |
    | AWS SDK credential chain
    v
EC2 instance role
    |
    | GetAuthorizationToken
    v
Amazon ECR

The resulting short-lived registry credential is consumed by kubelet for image
pulling.

AWS credentials are not stored in Kubernetes and are not passed to Pods.

## K3s locations

Binary:

    /var/lib/rancher/credentialprovider/bin/ecr-credential-provider

Configuration:

    /var/lib/rancher/credentialprovider/config.yaml

These correspond to the K3s credential-provider defaults.

## Registry scope

The provider is invoked only for:

    790072401452.dkr.ecr.us-east-1.amazonaws.com/gpulink/postgres-pgbackrest

## IAM

The EC2 host role has:

    ecr:GetAuthorizationToken

and repository-scoped:

    ecr:BatchCheckLayerAvailability
    ecr:BatchGetImage
    ecr:GetDownloadUrlForLayer

It does not have image push or repository administration permissions.

## Security boundary

EC2 IMDSv2 remains configured with:

    HttpTokens = required
    HttpPutResponseHopLimit = 1

The credential-provider process executes on the trusted host boundary.

Kubernetes workloads must remain unable to access IMDS.

No imagePullSecret containing AWS credentials should be created.
