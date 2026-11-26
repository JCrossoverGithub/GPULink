# DEV-07F — Installed Manager, two-host product acceptance

Recorded November 26, 2026 (Eastern). This record summarizes operator-supplied terminal output and screenshots from the project-guided acceptance exercise. It is not an independent third-party audit.

## Accepted release

- `main` revision `76fe60b114f88ca3d4369d4b2026c604c973cb96`, PR #48 merged November 26 03:11:43 UTC; nine applicable PR checks passed (CI 45747167144; distribution 45747167104), main-only delivery excluded from the PR checks.
- Source archive SHA-256 `371c31e3c53130ee7fb6e6d44109131ec7c8a81830a8d1bafebbeebe80cb1285`.
- Matching private CLI 0.1.0 distribution, TypeScript SDK and unchanged vector-search workload source. The example preparation script's release pin was updated in a disposable copy; workload/client code stayed unchanged. Bundle SHA-256 `0ca0e20442f5780792b5a7b31f3b88daf8170ab7b05ef682f82af0137f84ba7c`.
- Two Windows machines with WSL/Linux runtime: laptop hosts the managed Core and local Manager, desktop hosts the separate RTX 3090 Ti (24564 MiB). Authenticated private HTTPS and peer-scoped managed Windows forwarding/firewall. No AWS infrastructure involved.

## Evidence and scope

| Gate | Observed evidence |
| --- | --- |
| F1 | Release and inner candidate checksums verified; CLI installed outside checkout, laptop reports 0.1.0 and Manager help. Desktop independent worker uses the matching installed CLI. |
| F2 | Managed LAN startup and local TLS readiness reported; installed Manager opened automatically in Firefox, live operator-mode empty snapshot observed. |
| F3 | Invitation join, live TLS/worker-role checks, physical GPU inventory, verified pinned catalog, worker start/registration and fresh telemetry observed. PyTorch CUDA was available. |
| F4 | `job_0bb8bbcbaf694bb2b4f1496a0660cb14` succeeded in attempt 1; backend `pytorch-cuda`, exact integer reference ranking audio 95, video 93, render 88. Manager showed recorded worker/GPU and succeeded event. |
| F5 | Manager drain acknowledged; `job_31f9fa84fbb648958ee50748a8d3c0e3` queued with attempt 0. Resume acknowledged; same job succeeded in attempt 1 with exact reference ranking, no resubmission. Managed stop/restart and subsequent fresh heartbeat on the same sole worker/device observed. |
| F6 | Worker drained with zero active workloads and stopped; local status not-running. Server status offline, ownership records absent. `setup cleanup` reported owned Windows forwarding and firewall removed or already absent. Configuration and SQLite retained. |

Offline transition in Manager was not captured separately; no repeat physical exercise was required. No physical GPU cleanup-hold release was performed in this run. DEV-07D2 guarded recovery was previously accepted in the synthetic fixture and integration tests. No claims of hostile workload isolation, native Windows lifecycle, large-cluster performance, per-worker credential revocation, independently unassisted onboarding, or public registry publication follow from this exercise.

## Adoption friction observed

The generated worker name is long; an empty cluster does not explain the difference between join and start. Invitation transfer, review/approval and startup are separate terminal steps. Identical jobs are difficult to distinguish in tables; long resource text clips and acknowledgement wording persists after refresh. DEV-08 prioritizes clearer onboarding and bounded presentation polish, preserving the exact registration identity and explicit review/authorization requirements. External newcomer acceptance remains separate from team-guided testing.
