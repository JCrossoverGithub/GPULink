# Contributing to GPULink

GPULink is under active development. Open an issue before proposing a
substantial protocol, scheduler, persistence, security-boundary, or deployment
change.

## Development

Use Node.js 24 or newer.

Install dependencies:

```bash
npm ci
```

Run the repository verification gate with:

```bash
npm run check
```

PostgreSQL integration coverage expects `GPULINK_TEST_POSTGRES_URL` to point at
a disposable development/test PostgreSQL database.

For the standard local development container used by this project:

```bash
export GPULINK_TEST_POSTGRES_URL='postgresql://gpulink:gpulink-dev-only@127.0.0.1:5432/gpulink'
npm run check
```

Do not point the test suite at a production database. Some PostgreSQL tests
create and remove authoritative test state.

## Pull requests

- Create a focused feature branch.
- Keep public contracts versioned and backward-compatible where possible.
- Add deterministic tests for behavior changes.
- Preserve transaction, scheduling, lease, and event-delivery invariants.
- Never add credentials, model weights, generated databases, production
  backups, or user content.
- Update relevant architecture, API, deployment, recovery, and security
  documentation.
- Explain failure behavior, migration impact, rollback behavior, and
  operational impact in the pull request.
- Run `npm run check` and `git diff --check` before requesting review.

Contributions are made under the repository's Apache-2.0 license and should
include a Developer Certificate of Origin sign-off where required by project
policy.
