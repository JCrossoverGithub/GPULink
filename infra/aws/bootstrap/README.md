# GPULink AWS Bootstrap

This Terraform stack creates the durable S3 backend used by the rest of the
GPULink AWS infrastructure.

The backend bucket name is deployment-specific and is intentionally not
hard-coded into the public repository.

The state bucket provides:

- S3 versioning
- SSE-S3 encryption
- complete S3 Block Public Access
- bucket-owner-enforced object ownership
- HTTPS-only access policy
- Terraform destroy protection

## Fresh deployment

A brand-new AWS deployment starts with local Terraform state because the remote
state bucket does not exist yet.

Initialize the bootstrap stack without configuring the remote backend:

    terraform -chdir=infra/aws/bootstrap init -backend=false

Review and apply the bootstrap stack to create the S3 state bucket.

After the bucket exists, record its name and migrate the bootstrap state into
that bucket:

    terraform -chdir=infra/aws/bootstrap init \
      -migrate-state \
      -backend-config="bucket=<state-bucket-name>"

The backend key, region, encryption setting, and S3 lockfile configuration are
defined in `backend.tf`.

## Existing deployment

For an existing GPULink deployment whose state is already stored in S3, supply
the established bucket when initializing or reinitializing the working
directory:

    terraform -chdir=infra/aws/bootstrap init \
      -reconfigure \
      -backend-config="bucket=<existing-state-bucket-name>"

The production environment uses the same deployment-local bucket with its own
state key:

    terraform -chdir=infra/aws/environments/production init \
      -reconfigure \
      -backend-config="bucket=<existing-state-bucket-name>"

Using `-reconfigure` with the same established bucket and state keys does not
migrate the remote state. It only teaches the local Terraform working directory
the deployment-specific backend configuration.

Do not replace the established bucket with a new bucket unless a deliberate
Terraform state migration is being performed.

Do not delete the state bucket manually.
