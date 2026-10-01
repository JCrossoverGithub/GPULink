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

### Current AWS acceptance status

As of 2026-10-01, the AWS overlay has passed acceptance for PostgreSQL 17,
off-host recovery integration, the single-replica GPULink control plane, public
Traefik HTTP/HTTPS ingress, cert-manager-managed TLS, and the first physical
JPCMAIN RTX 3090 Ti `benchmark.gpu` workload.

Fleet-wide worker acceptance, multi-replica application behavior, application
rollback, sustained operation, and final production-state migration remain
open.

The `overlays/aws` directory contains configuration specific to the GPULink AWS production reference architecture.

Examples may include:

- AWS storage bindings
- production hostname configuration
- AWS-specific backup configuration
- production image registry settings

The committed AWS overlay does not contain AWS account-specific registry
names. It uses the reserved `registry.invalid` domain for fail-closed image
sentinels.

Both the PostgreSQL and control-plane sentinels retain their accepted
immutable OCI digests. Deployment rendering replaces only the registry
location while preserving those committed digest acceptance boundaries.

The committed public control-plane Ingress also uses the reserved hostname:

    control-plane.gpulink.invalid

The real public hostname is deployment material and is supplied only during
rendering. Real certificate and private-key material is provisioned separately
and must not be committed to Git.

Produce a deployable AWS manifest with both immutable image references and the
deployment public hostname:

    infra/kubernetes/scripts/render-aws.sh \
      '<aws-account-id>.dkr.ecr.<region>.amazonaws.com/gpulink/postgres-pgbackrest@sha256:<accepted-postgres-digest>' \
      '<aws-account-id>.dkr.ecr.<region>.amazonaws.com/gpulink/control-plane@sha256:<control-plane-release-digest>' \
      '<public-control-plane-hostname>' \
      > /tmp/gpulink-aws.yaml

The renderer requires both deployment-provided images to use the same
SHA-256 digests recorded by the committed manifests. Mismatched digests,
mutable image references, unresolved GPULink image sentinels, invalid public
hostnames, and unresolved hostname sentinels are rejected.

The AWS HTTPS Ingress expects a deployment-provided Kubernetes TLS Secret named
`control-plane-tls`. See
`overlays/aws/CONTROL_PLANE_TLS.md` for the certificate and provisioning
contract.

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

### AWS certificate management

The AWS certificate-management foundation lives separately under
`overlays/aws/cert-manager/`.

It installs cert-manager through the K3s `HelmChart` API and defines the
production Let's Encrypt `ClusterIssuer` contract. It is intentionally not
part of the normal application kustomization because the cert-manager CRDs
and webhook must become healthy before issuer resources are applied.

Deployment-specific ACME contact information is rendered outside Git.

See `overlays/aws/cert-manager/README.md` for installation order and lifecycle
boundaries.
