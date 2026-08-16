# Security Policy

## Supported versions

GPUlink is pre-release software. Security fixes are applied to the current
development version until the first tagged release establishes a support
policy.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory feature for the repository owner. Include affected versions,
reproduction steps, impact, and any suggested mitigation.

## Deployment expectations

- Terminate public traffic with valid HTTPS.
- Bind the control plane to loopback behind the reverse proxy.
- Keep worker machines outbound-only.
- Use different random client, worker, and administrator tokens.
- Do not commit environment files or credentials.
- Do not expose administrative endpoints to untrusted users.
- Do not add arbitrary remote command execution as a workload adapter.

GPUlink does not store inference content by default. Operators remain
responsible for the security and licenses of installed models and adapters.
