# GPULink Infrastructure

This directory contains infrastructure-as-code and platform configuration for
GPULink.

The active infrastructure milestone is Phase 4: migration from the
DigitalOcean Docker deployment to AWS and K3s.

See:

- `../docs/PHASE4_AWS_FOUNDATION.md`
- `../docs/ARCHITECTURE.md`
- `../docs/PRODUCTION_OPERATIONS.md`
- `../docs/ROADMAP.md`

## Principles

Infrastructure changes should be:

- reproducible;
- reviewable;
- least-privilege;
- recoverable;
- cost-conscious;
- incremental.

Do not place AWS credentials, application tokens, private keys, database
passwords, Terraform state, or Kubernetes Secret values in the
repository.

## Layout

    infra/
      aws/
        environments/
          production/
        modules/
      kubernetes/
        base/
        production/

The AWS reference infrastructure is now implemented. PostgreSQL runtime,
continuous WAL archival, full backup, and isolated restore verification have
been accepted. Application staging and production cutover remain Phase 4 work.

## Deployment-local Terraform backend

S3 backend bucket names are deployment-local and are intentionally not committed
to the public repository.

The AWS root modules retain their state key, region, encryption, and S3 lockfile
contract in `backend.tf`, but the `bucket` field is left empty.

Supply the bucket during `terraform init`, preferably with a deployment-local
backend configuration file passed through `-backend-config`.

Existing deployments must provide the same already-established state bucket when
reinitializing. Changing this source configuration does not itself move or alter
remote Terraform state.
