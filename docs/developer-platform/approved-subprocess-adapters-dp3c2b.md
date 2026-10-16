# DP3C2B candidate — operator-approved subprocess session adapters

Status: **candidate pending JPCMAIN acceptance**. This document does not authorize a production rollout.

## Purpose

GPULink supports independently developed GPU workloads through an operator-approved, explicitly configured local catalog. This DP3C2B path wires the generic DP3C1/DP3C2A subprocess supervisor into the existing `sessionAdapters` worker registry, alongside the DP3B trusted in-process adapter option. The scheduler, leased GPU placement and authenticated WebSocket relay are unchanged. Every client request selects a declared *capability* or pinned adapter identity, **never executable paths or arguments**.

## Operator configuration

By default, no external subprocess adapters are loaded. To opt in on a controlled test worker, the operator sets:

```
GPULINK_APPROVED_SUBPROCESS_CATALOG_PATH=/private/operator/approved-subprocesses.json
```

The catalog must be a regular, root- or worker-owned, non-group/world-writable file (on Linux) and must not be a leaf symlink. Catalog schema v1 has `schemaVersion: 1` and an `adapters` array. Each entry contains the existing v2 streaming-gateway `manifest` and a `command` with:

- `executable`: absolute interpreter or binary path, checked against `sha256` and a 64 MiB size limit
- `sha256`: exact lowercase hexadecimal SHA-256 of the executable bytes
- `args`: fixed operator-authored argv, max 16 strings; every absolute argv path must be listed in `assets`
- `assets`: up to 16 files, each with an absolute `path` and lowercase SHA-256 (each at most 4 MiB)

For the Python fixture: set `executable` to the real (not symlink) system Python binary, `args` to `["-I", "-B", "/private/operator/echo-subprocess.py"]`, and include the `.py` path and SHA-256 in `assets`. The example has no inference and requires no installed Python packages beyond the Python standard library.

Use owner-controlled directories and immutable deployment artifacts. All declared executable and asset hashes are verified before adapter registration and rechecked during readiness probing and session startup. A mutated file makes the adapter unavailable or prevents process launch. Duplicate adapter identities across subprocess and trusted JavaScript catalogs are rejected by the existing worker registry.

## Session behavior

The adapter bridge attaches a bounded ingress listener as the worker begins its session handler so early arriving frames are not dropped while approved artifacts are reverified and the subprocess handshakes. Once `gpulink.adapter.ipc` v1 `READY` is validated, the bridge forwards opaque data frames. It limits client-side IPC backlog and outbound WebSocket buffered bytes. Invalid UTF-8 text is rejected; binary is passed unchanged. A failed or lost relay, cancelled lease, failed subprocess, invalid protocol, or exhausted limit terminates the subprocess and **must not** imply successful workload completion.

This relay-ready and subprocess-READY sequence is **not model readiness**. Adapters must define and implement workload-specific model-ready and consumed-audio acknowledgements. The generic bridge cannot infer that a child consumed a frame from the fact that bytes were written to stdin.

## Trust and current limitations

**This is NOT a secure sandbox.** A subprocess can still share the worker's user permissions, read locally accessible files or `/proc` entries, reach local services/network, and spawn descendants. The supervisor clears inherited environment variables, but that does not guarantee secrecy of worker credentials accessible by other means. SHA-256 checks bind the operator's chosen files at read time but do not remove path/symlink races in parent directories or the gap between file verification and process launch. Binary dynamic libraries, Python imports and other unlisted runtime dependencies are not automatically pinned. Process-tree cleanup, OS-level resource quotas, network/UID isolation, and robust executable descriptor binding remain unresolved. **Do not use with untrusted code or enable on production GPU workers.**

DP3C2B accepts only small controlled, operator-trusted test adapters. Subsequent gates must address OS privilege isolation, process tree termination, package provenance/dependencies, GPU access scopes, and workload-specific completion semantics before broader third-party distribution.

## Acceptance checks

1. Default-disabled path, exact schema, digest, owner/mode, symlink and mutation checks.
2. Real supervised Python IPC echo via registry-style `handleSession` and fake WebSocket (no GPU).
3. Worker + in-memory control-plane + pinned adapter + authenticated relay end-to-end with a fake GPU on JPCMAIN.
4. Full repository regressions, Client SDK build and external-consumer test, and unchanged accepted DP3C2A source hashes.
5. No commits, network deployment, GPU inference, model download or package installation.
