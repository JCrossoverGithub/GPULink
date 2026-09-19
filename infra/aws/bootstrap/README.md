# GPULink AWS Bootstrap

This Terraform stack creates the durable S3 backend used by the rest of the
GPULink AWS infrastructure.

It intentionally starts with local Terraform state because the remote state
bucket does not exist yet.

The state bucket provides:

- S3 versioning
- SSE-S3 encryption
- complete S3 Block Public Access
- bucket-owner-enforced object ownership
- HTTPS-only access policy
- Terraform destroy protection

After the bucket is created and verified, the bootstrap state itself can be
migrated into the S3 backend.

Do not delete the state bucket manually.
