# Contributing to GPUlink

GPUlink is in early development. Open an issue before proposing a substantial
protocol, scheduler, security-boundary, or deployment change.

## Development

Use Node.js 24 or newer and run:

```bash
node --check src/control-plane/main.mjs
node --check src/worker/main.mjs
node --check src/cli/main.mjs
node --test
```

## Pull requests

- Create a focused feature branch.
- Keep public contracts versioned and backward-compatible where possible.
- Add deterministic tests for behavior changes.
- Never add credentials, model weights, generated databases, or user content.
- Update relevant architecture, API, deployment, and security documentation.
- Explain failure behavior and operational impact in the pull request.

Contributions are made under the repository's Apache-2.0 license and should
include a Developer Certificate of Origin sign-off where required by project
policy.
