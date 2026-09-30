# GPULink Kubernetes Deployment

GPULink Kubernetes configuration is intentionally separated into a cloud-neutral base and deployment-specific overlays.

## Layout

The directory structure is:

    infra/kubernetes/
    ├── base/
    │   └── Cloud-neutral GPULink resources
    └── overlays/
        ├── aws/
        │   └── AWS production-specific configuration
        └── self-hosted/
            └── Reference self-hosted configuration

## Base

The `base` directory must remain portable.

It may define resources such as:

- GPULink control-plane Deployment
- PostgreSQL workload configuration
- Services
- ConfigMaps
- Secrets interfaces
- PersistentVolumeClaims
- health checks
- resource requests and limits

It must not directly contain:

- EBS volume IDs
- AWS IAM role ARNs
- AWS-specific storage classes
- AWS load balancer annotations
- EC2 metadata dependencies
- S3 bucket names
- ECR-specific assumptions

## AWS Overlay

The `overlays/aws` directory contains configuration specific to the GPULink AWS production reference architecture.

Examples may include:

- AWS storage bindings
- production hostname configuration
- AWS-specific backup configuration
- production image registry settings

The committed AWS overlay does not contain AWS account-specific registry
names. It uses the reserved `registry.invalid` domain for fail-closed image
sentinels.

The PostgreSQL sentinel retains the accepted immutable OCI digest. The
control-plane sentinel remains zeroed until a release image has been built and
accepted for deployment.

Produce a deployable AWS manifest with both immutable image references:

    infra/kubernetes/scripts/render-aws.sh \
      '<aws-account-id>.dkr.ecr.<region>.amazonaws.com/gpulink/postgres-pgbackrest@sha256:<accepted-postgres-digest>' \
      '<aws-account-id>.dkr.ecr.<region>.amazonaws.com/gpulink/control-plane@sha256:<control-plane-release-digest>' \
      > /tmp/gpulink-aws.yaml

The renderer requires the PostgreSQL image to use the same digest recorded by
the committed overlay. Both deployment-provided image references must be
pinned by SHA-256 digest, and unresolved GPULink image sentinels are rejected.

## Self-Hosted Overlay

The `overlays/self-hosted` directory demonstrates that GPULink can run without AWS.

It may later support local or user-provided:

- persistent storage
- DNS
- TLS
- container registries
- backup repositories

## Principle

GPULink depends on capabilities, not providers.

For example:

- GPULink requires persistent storage, not EBS.
- GPULink requires PostgreSQL, not RDS.
- GPULink requires OCI images, not ECR.
- GPULink requires backup storage, not S3 specifically.
- GPULink requires secure administration, not Systems Manager specifically.
