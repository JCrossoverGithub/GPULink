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

## Planned layout

    infra/
      aws/
        environments/
          production/
        modules/
      kubernetes/
        base/
        production/

AWS resources will be introduced only after the Phase 4 architecture and state
strategy are reviewed.
