# GPULink capability and acceptance status

**Snapshot:** October 20, 2026, after PR #25 merged into `main` at
`03cf54617aed71d4c4cd188ed68334a36443e545`.

This page describes verified **source capabilities and dated acceptance
results**, not live service health. "Implemented" means code/contracts exist;
"accepted" means a bounded test or documented operator gate passed;
"published" refers to an externally obtainable distribution. A dated
AWS production acceptance is **not** certification of a running service today.
Historical design documents should not be interpreted as up-to-date install
instructions. Keep this matrix synchronized when a new acceptance gate merges.

**Dated evidence addendum — October 24, 2026:** Independent source-checkout two-host acceptance passed on tested revision `c88b9f8e795399d73d74b9b34a9c157728de2600`, using one physical GPU telemetry diagnostic. The historical October 20 snapshot above is retained. See [G9 evidence](acceptance/independent-two-host-acceptance-2026-10-24.md) for the exact tested scope, limits, and teardown. This does **not** mean the two-host installation workflow is packaged or production-ready.

| Capability | Implemented | Accepted evidence | Distribution / current limit |
| --- | --- | --- | --- |
| Scheduler, leases, workers and finite GPU jobs | Yes | Physical fleet, AWS/K3s history (October 13); fresh installed local diagnostic (October 20) | Approved jobs only; not raw shell or pooled VRAM |
| Linux/WSL local managed control plane | Yes | Source-built CLI install, start/status/stop and restart passed in PRs #22–#25 | Private CLI preview; localhost scope; not Windows-native service management |
| Linux/WSL managed local GPU worker | Yes | One physical worker registered, accepted bounded job, and shut down in reverse dependency order (PRs #24–#25) | Explicit `--accept-assigned-work`; no remote enrollment through `local` |
| Reproducible installed hardware acceptance | Yes | `scripts/acceptance/installed-local-gpu-diagnostic.sh` passed on RTX 3090 Ti (October 20) | NVIDIA `nvidia-smi`; operator opt-in; excluded from unattended CI |
| PostgreSQL multi-replica control plane and disaster recovery | Yes | October 13 AWS/K3s Phase 4E and earlier staging acceptance | Historical environment evidence; clean-room external operator procedure still missing |
| Session scheduling and authenticated WebSocket relay | Yes | Core contract tests and operator-trusted two-machine CaptionLink integration (October 20) | Adapter/model readiness is distinct from relay readiness |
| .NET Client SDK | Yes | Cross-platform SDK CI and CaptionLink two-machine inference | NuGet `GPULink.Client` **0.1.0-preview.1**, .NET 10, not stable API |
| TypeScript Client SDK | Yes | Build/contract/external-consumer tests | `@gpulink/client` **private**, pre-v1, Node.js 24+; not a verified public npm release |
| Adapter SDK and pinned subprocess packaging | Yes | Echo conformance, reviewable packaging, independently approved adapters | `@gpulink/adapter-sdk` **private**, pre-v1; approved subprocess is **not** a hostile-code sandbox |
| Visual operations console | Yes (read-only) | Angular/Flask build and test coverage in CI | Not a general-purpose managed cluster control panel |
| Independent two-host operator deployment | Operator-guided source-checkout acceptance on October 24; packaged workflow not accepted | G0–G8 passed on separate physical hosts: one GPU diagnostic, lease cleanup, controlled restart, authentication/TLS checks, stale heartbeat, recovery, teardown | Manual TLS/credential/LAN provisioning; not yet a packaged or unguided third-party installation |

## How to verify the claimed boundaries

- **Local installed GPU path:** [GPU diagnostic gate](INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md) and [CLI package/lifecycle](CLI_DISTRIBUTION.md).
- **Consumer/adapter roles and two-machine evidence:** [Getting started](GETTING_STARTED.md), [TypeScript SDK](../packages/gpulink-sdk/README.md), [.NET SDK](../packages/gpulink-dotnet/GPULink.Client/README.md), and [Adapter SDK](../packages/gpulink-adapter-sdk/README.md).
- **Historical AWS acceptance:** [Phase 4E migration](security/aws-phase4e-production-acceptance-2026-10-13.md) and [Roadmap](ROADMAP.md). These records are not a live status check.
- **Current CI:** [GitHub Actions workflow](../.github/workflows/ci.yml) tests Linux/Windows Core, the dashboard, and the .NET SDK. It does not automatically perform physical GPU diagnostics or provision a disposable PostgreSQL instance for the optional integration suite.

## Outstanding adoption and operational gates

1. **Packaged independent two-host onboarding:** The October 24 operator-guided source-checkout diagnostic passed. Externally installable control-plane/worker distributions, secure guided TLS/credential enrollment, version upgrades/rollback, and independent newcomer acceptance remain outstanding.
2. **Disposable PostgreSQL CI acceptance:** run and clean up database-backed integration tests separately from normal GPU-free CI, including explicit scope acknowledgments.
3. **SDK releases and compatibility:** decide supported OS/runtime matrix, provenance and update policy; do not describe `private` npm packages as published.
4. **Adapter portability and isolation:** accept at least one second independently authored, non-ASR workload; keep trusted operator approval separate from claims of arbitrary-code sandboxing.
5. **Operator upgrade / rollback and lifecycle ownership:** verify installation migration and crash recovery outside the original deployment, rather than extrapolating the local developer preview into production supervision.

**No credentials, certificates, environment-specific fingerprints, personal host
names, or live deployment endpoints belong in this status contract.**
