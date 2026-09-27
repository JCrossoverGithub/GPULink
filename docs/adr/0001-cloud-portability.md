# ADR 0001: Cloud Portability Is a Core GPULink Constraint

## Status

Accepted

## Context

GPULink is being given a production reference deployment on AWS during Phase 4.

The AWS deployment uses services such as:

- EC2 for compute
- EBS for persistent block storage
- S3 for PostgreSQL backup and WAL storage
- IAM instance roles for AWS authorization
- Systems Manager Session Manager for host administration
- ECR for OCI image distribution

These services are infrastructure choices for the GPULink production deployment. They must not become requirements of the GPULink application itself.

GPULink should remain deployable on:

- AWS
- other public clouds
- private datacenters
- home or lab infrastructure
- bare-metal Linux
- self-hosted Kubernetes or K3s

## Decision

Cloud portability is a core GPULink architectural constraint.

The GPULink application layer must remain independent from AWS-specific infrastructure APIs and concepts.

AWS will be treated as a production deployment profile and reference architecture rather than as part of the GPULink application contract.

## Architectural Rules

### Application code

GPULink application code must not require:

- EC2 instance metadata
- AWS IAM APIs
- EBS APIs
- S3 APIs
- ECR APIs
- Systems Manager APIs
- AWS resource identifiers

Cloud-specific functionality may only be introduced behind an explicit adapter or deployment integration.

### Containers

GPULink services must be distributed as standard OCI container images.

Images must not require a specific container registry.

For example, the same GPULink image should be usable from:

- Amazon ECR
- GitHub Container Registry
- Docker Hub
- Harbor
- another OCI-compatible registry

### PostgreSQL

GPULink depends on PostgreSQL, not on an AWS database product.

The database must be able to run with any suitable persistent filesystem or Kubernetes storage implementation.

AWS production may use EBS, while another deployment may use:

- local block storage
- SAN or NAS-backed storage
- Ceph
- Longhorn
- another Kubernetes CSI implementation

### Backups

PostgreSQL backup behavior must be defined independently of AWS.

The AWS production profile may use pgBackRest with S3.

Other deployments may use another pgBackRest-compatible repository configuration or supported object-storage implementation.

Static AWS credentials must not be required by GPULink core.

### Kubernetes

Base Kubernetes configuration must not contain AWS-specific infrastructure assumptions.

The base configuration must not require values such as:

- AWS storage class names
- EBS volume IDs
- AWS IAM roles
- AWS load balancer annotations
- AWS-specific CSI drivers

Provider-specific configuration belongs in deployment overlays.

### GPU workers

GPU workers communicate with the GPULink control plane through the GPULink network protocol.

Workers must not need to know which cloud or infrastructure provider hosts the control plane.

A worker should operate the same whether the control plane is hosted on AWS, another cloud, or a self-hosted server.

## Deployment Model

GPULink deployment configuration will be organized into a portable base and environment-specific overlays.

Conceptually:

    infra/kubernetes/
      base/
      overlays/
        aws/
        self-hosted/

The base contains cloud-neutral GPULink resources.

The AWS overlay contains configuration required specifically by the AWS production deployment.

The self-hosted overlay provides a reference deployment without AWS dependencies.

Additional provider overlays may be added later without changing the GPULink core application.

## Reference Architecture

The Phase 4 AWS environment is designated:

**GPULink Production Reference Architecture - AWS**

It demonstrates one supported production deployment of GPULink.

It does not define the minimum platform requirements for GPULink itself.

## Consequences

This decision may require slightly more configuration than directly embedding AWS assumptions into GPULink.

In exchange, GPULink retains:

- self-hosting capability
- cloud-provider independence
- simpler migration between infrastructure providers
- easier local and development environments
- clearer separation between application and infrastructure
- reduced vendor lock-in

Any future change that introduces a cloud-specific dependency into GPULink core must be treated as an architectural change and reviewed against this decision.

## Portability Acceptance Gate

A deployment change is not portable merely because GPULink can theoretically
be ported away from the current provider.

The portable Kubernetes base must be deployable without AWS.

Nothing under:

    infra/kubernetes/base

may require:

- Amazon ECR;
- AWS IAM;
- EC2 Instance Metadata Service;
- Amazon EBS;
- Amazon S3;
- AWS-specific Kubernetes identity;
- AWS-specific storage classes;
- AWS-specific service names or APIs.

Provider-specific behavior belongs in deployment profiles or overlays such as:

    infra/kubernetes/overlays/aws

An AWS overlay may select an ECR image location, configure host authentication,
or provide AWS-specific storage and infrastructure.

Those choices must not become part of the GPULink application contract.

The same portable base must remain usable by a self-hosted or other-cloud
deployment with equivalent capabilities supplied through that environment.
