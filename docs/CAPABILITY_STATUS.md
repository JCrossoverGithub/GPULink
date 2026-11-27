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
| Versioned CLI distribution | Yes | PR #30 (November 25): Node 24 local acceptance, Linux/Windows package CI passed | Downloadable CI candidate; registry availability is verified separately |
| Linux server profile with operator-managed HTTPS ingress | Yes | PR #31 (November 25): installed Linux server lifecycle and real local HTTPS acceptance, all eight CI checks passed | Single loopback backend, separately configured proxy; no public TLS provisioning |
| Managed remote worker profile | Yes | [PR #32 acceptance](acceptance/installed-remote-worker-acceptance-2026-11-25.md) (November 25): installed cross-host HTTPS diagnostic, drain, stop, offline and same-identity rejoin; corrected commit CI passed | Trusted worker-role bundle, Linux/NVIDIA diagnostics only; no one-time invite or per-worker revocation |
| Scheduler, leases, workers and finite GPU jobs | Yes | Physical fleet, AWS/K3s history (October 13); fresh installed local diagnostic (October 20) | Approved jobs only; not raw shell or pooled VRAM |
| Linux/WSL local managed control plane | Yes | Source-built CLI install, start/status/stop and restart passed in PRs #22–#25 | Private CLI preview; localhost scope; not Windows-native service management |
| Linux/WSL managed local GPU worker | Yes | One physical worker registered, accepted bounded job, and shut down in reverse dependency order (PRs #24–#25) | Explicit `--accept-assigned-work`; no remote enrollment through `local` |
| Reproducible installed hardware acceptance | Yes | `scripts/acceptance/installed-local-gpu-diagnostic.sh` passed on RTX 3090 Ti (October 20) | NVIDIA `nvidia-smi`; operator opt-in; excluded from unattended CI |
| PostgreSQL multi-replica control plane and disaster recovery | Yes | October 13 AWS/K3s Phase 4E and earlier staging acceptance | Historical environment evidence; clean-room external operator procedure still missing |
| Session scheduling and authenticated WebSocket relay | Yes | Core contract tests and operator-trusted two-machine CaptionLink integration (October 20) | Adapter/model readiness is distinct from relay readiness |
| .NET Client SDK | Yes | Cross-platform SDK CI and CaptionLink two-machine inference | NuGet `GPULink.Client` **0.1.0-preview.1**, .NET 10, not stable API |
| TypeScript Client SDK | Yes | Build/contract/external-consumer tests | `@gpulink/client` pre-v1, Node.js 24+; not a verified public npm release |
| Adapter SDK and pinned subprocess packaging | Yes | Echo conformance, reviewable packaging, independently approved adapters | `@gpulink/adapter-sdk` pre-v1; approved subprocess is **not** a hostile-code sandbox |
| Visual operations console | Yes (installed C+ Manager) | [DEV-07F physical acceptance](acceptance/installed-manager-two-host-2026-11-26.md): private package, live GPU telemetry, job placement and drain/resume, PRs #42–#48 | Local operator boundary; guarded recovery tested in synthetic fixture; no public multi-user administration |
| Independent two-host operator deployment | Yes (manual operator-guided packaged path) | October 24 source-checkout acceptance; November 25 PR #32 packaged server/worker diagnostic and lifecycle acceptance | Manual ingress/enrollment; mixed protocol-compatible artifact revisions; no independent newcomer acceptance |
| Managed LAN onboarding | Yes | PR #33 (November 25): physical WSL2 NAT provisioning, enrollment, remote diagnostic, durable result and automatic cleanup; 8 CI checks passed | Optional WSL2 NAT private LAN foreground session; no generalized native service installer or automatic in-place IP repair |
| Installed trusted external GPU workloads | Yes | PR #34 (November 25): independently packaged external CUDA session, correct matrix result, persisted allocation/release, 8 CI checks passed | Existing GLIP subprocess/session backend; no hostile-code sandbox |
| Uncertain running-job cleanup holds | Yes | PR #35 (November 25): 67 local tests, installed acceptance and 9 CI checks including PostgreSQL; [job cleanup safety](JOB_CLEANUP_SAFETY.md) | Conservative durable quarantine and explicit operator-attested recovery, not verified hardware isolation |
| Installed durable external batch workloads | Yes | PR #36 (November 25): independent installed CUDA batch, cancellation, quarantine, explicit recovery, restart persistence and 9 CI checks; [external batch preview](EXTERNAL_BATCH_PREVIEW.md) | Operator-approved bounded JSON jobs, not arbitrary-code isolation or large artifacts |
| Coordinated distribution and accepted-source delivery | Yes | PRs #39–#40 (November 25): four packages, Linux/Windows installation and verified release archive; [release delivery](RELEASE_DELIVERY.md) | CI candidate, no new public release or registry publication |
| Independent vector-search reference application | Yes | [DEV-06 physical acceptance](acceptance/independent-vector-search-2026-11-25.md): separate application and worker, exact CUDA result, one attempt, teardown | Team-guided small batch example; independent newcomer acceptance remains outstanding |

## How to verify the claimed boundaries

- **Local installed GPU path:** [GPU diagnostic gate](INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md) and [CLI package/lifecycle](CLI_DISTRIBUTION.md).
- **Consumer/adapter roles and two-machine evidence:** [Getting started](GETTING_STARTED.md), [TypeScript SDK](../packages/gpulink-sdk/README.md), [.NET SDK](../packages/gpulink-dotnet/GPULink.Client/README.md), and [Adapter SDK](../packages/gpulink-adapter-sdk/README.md).
- **Historical AWS acceptance:** [Phase 4E migration](security/aws-phase4e-production-acceptance-2026-10-13.md) and [Roadmap](ROADMAP.md). These records are not a live status check.
- **Current CI:** [GitHub Actions workflow](../.github/workflows/ci.yml) tests Linux/Windows Core, the dashboard, and the .NET SDK. It provisions disposable PostgreSQL for the job cleanup integration gate; physical GPU diagnostics and other optional integration suites are not automatically run.

## Outstanding adoption and operational gates

1. **Packaged independent two-host onboarding:** The October 24 operator-guided source-checkout diagnostic passed. DEV-01 delivered a versioned installable CLI candidate; DEV-02 delivered the installed server profile. DEV-03 delivered the [remote worker preview](REMOTE_WORKER_PREVIEW.md) and passed guided physical acceptance (PR #32). The [managed LAN onboarding preview](MANAGED_LAN_PREVIEW.md) passed physical acceptance in PR #33. Version upgrades/rollback and independent newcomer acceptance remain outstanding.
2. **Disposable PostgreSQL CI acceptance:** job cleanup gate passed in PR #35; additional optional database integration suites remain separately scoped.
3. **SDK releases and compatibility:** decide supported OS/runtime matrix, provenance and update policy; verify registry availability before describing npm packages as published.
4. **Adapter portability and isolation:** DEV-06 accepted an independently packaged, team-authored non-ASR vector-search application; external newcomer acceptance and broader runtime portability remain outstanding. Keep trusted operator approval separate from claims of arbitrary-code sandboxing.
5. **Operator upgrade / rollback and lifecycle ownership:** verify installation migration and crash recovery outside the original deployment, rather than extrapolating the local developer preview into production supervision.

**No credentials, certificates, environment-specific fingerprints, personal host
names, or live deployment endpoints belong in this status contract.**
