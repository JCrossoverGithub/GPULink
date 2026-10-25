# GPULink — Independent Two-Host Operator Acceptance

**G9 Engineering Acceptance Report**

**Date:** 2026-10-24

**Tested source revision:** `c88b9f8e795399d73d74b9b34a9c157728de2600` (PR #28 candidate)

**Disposition:** **PASS for the bounded, operator-guided two-host diagnostic scenario**

**Not a production certification, public installer acceptance, arbitrary CUDA execution test, or unguided third-party onboarding test.**

## 1. Executive conclusion

A disposable Ubuntu 24.04.5 virtual-machine control plane on one physical computer, and a separately cloned Ubuntu 24.04 WSL2 GPU worker on a second physical computer, successfully completed a single explicitly authorized `diagnostic.gpu-status` job on a physical NVIDIA RTX 3070 Ti. The implementation persisted the terminal result, cleared its active GPU job lease, survived a controlled control-plane restart, and recovered worker heartbeats both after control-plane restart and after controlled worker shutdown/restart. Bounded negative checks showed appropriate role-scoped API rejection, non-loopback cleartext URL rejection, TLS trust enforcement, and stale-heartbeat offline detection. Teardown stopped dependent services in order, closed the test-owned ingress, and preserved evidence.

The result validates **this specific source checkout and operator-assisted scenario**. It does not prove an installable distribution, no-instructions external adoption, generalized device enrollment, malicious-adapter isolation, raw GPU compute, active-job crash recovery, PostgreSQL multi-replica operation, or production readiness.

## 2. Test boundary

- **Host A:** disposable Ubuntu 24.04.5 VM, Node.js 24.22.1, one loopback-bound GPULink control-plane process, isolated SQLite state, separate Caddy TLS ingress.
- **Host B:** different physical computer, Ubuntu 24.04 WSL2, Node.js 24.22.1, physical NVIDIA GeForce RTX 3070 Ti (8 GiB), independent checkout, single GPULink worker process.
- **Network:** ordinary local Wi-Fi; Host B initiated authenticated HTTPS connections through the VM host's specifically scoped NAT port forwarding. No VPN or AWS service was required.
- **Trust:** manually provisioned local private CA, certificate checked for the configured service identity, private tokens for admin/client/worker roles and a separate data-plane signing key. Secret values are intentionally excluded.
- **Workload authorization:** exactly **one** `diagnostic.gpu-status` job, one GPU, one permitted attempt. No benchmark, inference, or other GPU computation was authorized in this exercise.
- **Evidence scope:** console outputs supplied by the operator and two timestamped JSON snapshots stored on Host A. This report is redacted; do not commit machine-specific identifiers, live endpoints, credentials, certificate material, or private fingerprints to the public repository.

## 3. Gate-by-gate results

| Gate | Accepted scope | Observed outcome | Status |
|---|---|---|---|
| **G0** | Revision, inventory, ownership | Exact accepted commit checked on both independent source checkouts; VM and physical-GPU worker runtime inventories checked, including RTX 3070 Ti availability. | **PASS** |
| **G1** | TLS and credential design | Four distinct role/transport secrets provisioned privately; loopback backend and separate TLS ingress planned. | **PASS for this deployment** |
| **G2** | Disposable Host A | Loopback-only Node control plane, private configuration and SQLite state, Caddy ingress; authenticated health/readiness and HTTPS transport exercised. | **PASS** |
| **G3** | Remote trust | Host B established authenticated HTTPS through a validated CA/hostname relationship. Invalid trust paths were rejected in later G7 checks. | **PASS for observed valid connection** |
| **G4** | Independent Host B registration | Separate physical worker registered one physical NVIDIA RTX 3070 Ti, reported live inventory, and advanced heartbeats using stable identity. | **PASS** |
| **G5** | One allowlisted physical job | Exactly one `diagnostic.gpu-status` job succeeded on assigned GPU, one attempt, persisted result and lease identifier; no active leases remained. | **PASS** |
| **G6** | Controlled restart and persistence | Gracefully stopped/restarted control plane using same SQLite DB and credentials; preserved succeeded job, one attempt, zero leases and worker automatic heartbeat recovery. | **PASS** |
| **G7-A** | Auth negative checks | Nine of nine missing/invalid, cross-role, and permitted-role API GET tests returned expected 401/200 responses. | **PASS** |
| **G7-B** | TLS and cleartext negatives | Six of six URL policy and TLS probes passed: two remote HTTP rejections, localhost exception, trusted-host acceptance, wrong-SNI rejection, untrusted-CA rejection. | **PASS, with hostname caveat below** |
| **G7-C** | Worker liveness | Following controlled worker shutdown, control plane marked worker offline at 16.5 seconds since last heartbeat; restart brought same worker online, heartbeat advanced 15.307 seconds, original job remained single-attempt. | **PASS** |
| **G8** | Teardown and evidence | Redacted JSON snapshots saved; worker stopped before control plane; Caddy stopped and disabled at boot; test NAT HTTPS forwarding, Windows firewall exception and temporary DNS hosts entry removed; SSH localhost access and persistent state intentionally retained. | **PASS** |
| **G9** | Redacted dated report | This report records results, evidence, limitations, and recommended follow-up. | **COMPLETE upon report review** |

## 4. Key numeric evidence

| Measure | Observed value |
|---|---|
| Physical GPUs exercised | 1 NVIDIA RTX 3070 Ti, 8192 MiB inventory |
| Authorized GPU jobs submitted | 1 |
| Original job terminal status | `succeeded` |
| Execution attempts / allowed maximum | `1 / 1` |
| Persisted job records at G8 snapshot | 1 |
| Persisted sessions at G8 snapshot | 0 |
| Active job leases at G8 snapshot | 0 |
| Active session leases at G8 snapshot | 0 |
| G7-A auth tests | 9/9 PASS |
| G7-B TLS/URL tests | 6/6 PASS |
| Stale-worker offline observation | 16.5 s after last heartbeat |
| Worker heartbeat advancement after restart | 15.307 s between samples |
| Host A SQLite size after controlled shutdown | 102,400 bytes |
| Final healthy state captured | 2026-10-24 20:20:48 UTC |

## 5. Teardown disposition

**Stopped:** GPU worker; control-plane process; Caddy HTTPS service.

**Removed:** test-only VirtualBox NAT HTTPS forwarding; test-only Windows firewall rule; temporary Host B `/etc/hosts` mapping.

**Preserved intentionally:** separate VirtualBox localhost SSH forwarding (2222), test source checkouts, local private environment and public CA file, SQLite database, Caddy configuration/CA state, and JSON evidence snapshots.

**Windows trust:** exact test CA not found in six examined certificate stores on either physical computer. **Host B Ubuntu:** not trusted by standard CA bundle; test worker used an explicitly configured additional CA file. **Unexamined enterprise/policy stores and other users' trust stores were not audited**, so trust claims are limited to stores tested. The local Caddy CA is still present inside its disposable host and was not deleted.

## 6. Evidence index

These paths are **operator-private pointers**, not downloadable files bundled in this report:

1. **Final healthy/pre-teardown snapshot:** `~/.local/state/gpulink/independent-host-a/evidence/g8-pre-teardown-1792873248070.json` on Host A.
2. **Worker-offline/pre-control-plane-shutdown snapshot:** `~/.local/state/gpulink/independent-host-a/evidence/g8-worker-stopped-1792874647204.json` on Host A.
3. **Persistent test database:** `~/.local/state/gpulink/independent-host-a/control-plane.sqlite` on Host A.
4. **Operator terminal record:** G5 final job result and lease verification; G6 restart checks; G7-A/B/C negatives and recovery; G8 verification/cleanup. These were observed in the conversation; they have not all been separately exported to immutable machine-readable evidence files.

**Evidence integrity caveat:** The snapshots are operational evidence but are not signed, hashed into a tamper-evident manifest, independently witnessed, or attached to a CI run. A follow-up can derive checksums after securing the evidence directory. Do not mistake this report for a forensic audit.

## 7. Limits and untested claims

1. **GPU telemetry vs computation:** The approved `diagnostic.gpu-status` queried the real device. It did not establish successful CUDA kernels, model inference, or arbitrary developer adapters in this test.
2. **Single worker / single GPU / single job:** No contention, scale, distributed fairness, heterogeneous placement, failover across workers, or multi-GPU job behavior was exercised.
3. **Graceful vs abrupt failure:** Control-plane and worker stops were deliberate and without active jobs. No mid-execution loss, double-execution prevention during ambiguous lease ownership, network partition under load, lease reconciliation after hard crash, or hostile process failure was tested.
4. **TLS hostname negative nuance:** The wrong-servername probe elicited a TLS handshake/SNI alert from Caddy; this does not independently prove client-side certificate-name mismatch handling. Untrusted-CA rejection and correct-host positive validation were directly observed.
5. **Scoped deployment secrets:** API roles rejected inappropriate credentials at sampled routes, but worker credentials remain deployment-scoped rather than individually provisioned and revocable. A broader authorization audit was not conducted.
6. **Operator-guided installation:** Setup required manual VirtualBox forwarding, CA trust, credential transfer, DNS/hosts configuration, and precise source-checkout commands. It is a meaningful **real two-host proof**, not yet independent newcomer/onboarding acceptance or installed CLI lifecycle acceptance.
7. **SQLite/local scope:** The test used one SQLite control plane; it did not validate PostgreSQL HA, backup/restore, upgrade/rollback, or remote production supervision.
8. **Platform neutrality:** The code contract is not intended to require WSL, but this GPU host ran WSL2. Native Linux GPU worker, Windows-native worker, and other hardware/driver combinations were not acceptance-tested here.
9. **Adapter security:** Only the approved diagnostic adapter was used. No sandboxing guarantee or hostile third-party adapter execution was established.
10. **Trust cleanup scope:** Six Windows certificate stores per host and the Host B Ubuntu CA bundle were checked. Other users or policy-managed stores were not assessed. Test CA files and VM-internal local CA state were intentionally retained.

## 8. Engineering decision and priorities

**Decision:** Accept G0–G8 for the precisely bounded operator-guided independent two-host test on the tested revision. Mark G9 complete as a redacted engineering record. Do **not** relabel the project broadly production-ready or publicly self-installable on the strength of this test alone.

**Priority 1 — Retain and reconcile evidence, not rerun successful diagnostics.** Securely archive both JSON snapshots, the controlled-test transcript, revision, and redacted gate matrix. Create a repository PR to update capability status and cross-reference this dated acceptance while preserving the historical PR #28 document's original scope.

**Priority 2 — Deliberate distribution boundary.** Ship an external installable `gpulink` CLI and role-specific components rather than requiring source clones or publishing the entire development monorepo. Specify supported Node/runtime/OS versions, versioning, upgrades, rollbacks, and local state ownership.

**Priority 3 — Safe, guided multi-host onboarding.** Automate or guide configuration preflight, worker identity, TLS trust verification, credential transfer/rotation, and scoped network changes; retain no mandatory VPN, cloud account, WSL assumption, or application-specific dependency. Do not prematurely build LAN discovery or broad pairing infrastructure.

**Priority 4 — Failure and isolation validation.** Add explicit consented, controlled tests for abrupt worker/control-plane failure during active work, ambiguous lease ownership, partitions, and recovery. Test an independently authored non-captioning adapter and physical CUDA computation separately, with honest distinction between approved subprocess adapters and hostile-code sandboxes.

**Priority 5 — Independent operator usability acceptance.** Have a fresh operator follow packaged instructions on clean supported hosts. Measure manual steps, time-to-first-safe-job, common errors, cleanup reliability, and secret-handling behavior; revise onboarding based on observed friction.

## 9. Supporting repository contracts

- Gate definition: https://github.com/JCrossoverGithub/GPULink/blob/c88b9f8e795399d73d74b9b34a9c157728de2600/docs/INDEPENDENT_TWO_HOST_OPERATOR.md
- Capability boundary: https://github.com/JCrossoverGithub/GPULink/blob/c88b9f8e795399d73d74b9b34a9c157728de2600/docs/CAPABILITY_STATUS.md
- Architecture and invariants: https://github.com/JCrossoverGithub/GPULink/blob/c88b9f8e795399d73d74b9b34a9c157728de2600/docs/ARCHITECTURE.md

**Reporting rule:** When publishing any version of this report, omit environment-specific hostnames, IPs, machine user names, hardware UUIDs, secret values, certificate fingerprints, and internal access details. The published status must not imply tests ran on another revision, machine, or workload.
