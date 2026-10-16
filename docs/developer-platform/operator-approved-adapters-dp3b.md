# DP3B — Operator-approved single-file session adapters

**Status:** candidate implementation, locally unit-tested; GPULink integration acceptance pending JPCMAIN. Not a stable or safely sandboxed Adapter SDK.

## The core boundary

GPULink worker startup may load explicit, operator-selected, digest-pinned **single-file ESM** session adapters without editing GPULink source. Default: disabled. The platform client cannot install code, provide entrypoints, choose local paths, or authorize a new adapter. Only an operator may provision and enable a catalog.

- Existing v2 `manifest` (`schemaVersion:2`, `type`, `adapterId`, `version`, `executionMode:"streaming-gateway"`) remains **unchanged**.
- New *operator-local* catalog schema is **separate** from public adapter manifests. It pins a local absolute file path and its SHA-256 digest. Do not add `entrypoint` or `sha256` to an existing v2 manifest.
- The loader verifies catalog schema, regular-file ownership/mode, SHA-256 for **all** configured source files before evaluating any adapter. It imports the **verified bytes** as an ESM `data:` module instead of reopening the path after verification. At startup a mismatch fails closed rather than silently dropping a pinned adapter.
- Loaded adapter must export `createAdapter()` returning `{ manifest, readinessProbe, handleSession }`. The factory-provided manifest must match the operator-approved manifest, and `WorkerAgent` applies the existing registry/manifest validation and readiness/probe/dispatch semantics.
- No ad hoc dynamic modules enter from client session data; no downloads or npm installs are performed at startup. Changing the catalog requires a worker restart.

## Operator installation (on an isolated development worker)

1. Review and approve an independently authored **single ESM file**. No automatic package manager or executable installation is implied. For example, copy `examples/external-adapter/echo-stream.mjs` to `/opt/gpulink/approved-adapters/echo-stream.mjs`.
2. Make the file owned by the worker account or root and **not writable by group or others** (e.g., `chmod 600` on Linux). Place catalog and adapter under a controlled, non-writable-by-untrusted-users directory. Directory access permissions remain the operator's responsibility.
3. Compute the **actual** SHA-256 of the approved file: `sha256sum /opt/gpulink/approved-adapters/echo-stream.mjs`.
4. Create an operator-owned, mode `600` catalog at a local absolute path (example below). Replace `REPLACE_WITH_ACTUAL_64_HEX_SHA256` with the computed value.
5. Set `GPULINK_APPROVED_ADAPTERS_CATALOG_PATH=/opt/gpulink/approved-adapters/catalog.json` in the **worker's trusted deployment configuration**, then restart the worker. Do **not** set this using values from an HTTP request or public client. The worker still requires its normal credentials, backend, and GPU setup.
6. A suitable worker then advertises only adapters whose readiness probe returns `true`. Clients may request a session with the corresponding `capability` and exact v2 `requirements.adapter`. Adapter protocol messages remain adapter-defined.

```json
{
  "schemaVersion": 1,
  "adapters": [
    {
      "manifest": {
        "schemaVersion": 2,
        "type": "example.echo.streaming",
        "adapterId": "example.echo.streaming.v1",
        "version": "1.0.0",
        "executionMode": "streaming-gateway"
      },
      "entrypoint": "/opt/gpulink/approved-adapters/echo-stream.mjs",
      "sha256": "REPLACE_WITH_ACTUAL_64_HEX_SHA256"
    }
  ]
}
```

## Security and operational limitations — read before enabling

**This is trusted in-process execution, NOT a sandbox.** A pinned ESM module can import Node builtins and access worker credentials, filesystem, network, and GPU privileges available to the worker account. SHA-256 verifies byte identity only; it does **not** establish publisher identity, signatures, provenance, safety, license suitability, or supply-chain security. Only load operator-vetted code on an appropriate trusted worker. Do not enable arbitrary internet-supplied code or client-provided scripts.

- Single-file ESM is intentional at DP3B: no relative imports or multi-file dependency trees, and no package manager installation flow. Native/Python/C++ workloads will need a language-neutral supervised subprocess protocol and operator-managed runtime in later DP stages.
- Adapter factory evaluation is trusted and occurs at worker startup; it is not a CPU/time/memory sandbox. A malicious or buggy adapter can hang or crash the worker. Deployment isolation, dedicated service accounts, subprocess/container supervision, resource limits, signatures, revocation and rollout/rollback are **future gates**.
- Catalog and adapter regular files must be bounded (`64 KiB` catalog, `256 KiB` ESM source), have acceptable ownership and not be writable by group/others on POSIX. Symlink *leaf files* are not accepted. The operator must secure parent directories as well. Verification happens at startup, not continuously.
- Runtime readiness is whatever `readinessProbe()` actually proves; a passing probe must not be conflated with successful GPU/model initialization or with transport pairing. The sample echo adapter has no model or GPU inference.
- Existing session allocation, adapter ID pinning, worker lease renewal, authenticated v2 relay, cancellation and authoritative session cleanup are unchanged. DP3B does not modify ASR protocol or CaptionLink.

## Acceptance requirements

Run `node --test test/approved-session-adapters.test.mjs test/approved-adapter-e2e.test.mjs`, then root `npm run check` and SDK build/tests on JPCMAIN with a cleanly guarded DP2A+DP3B state. The e2e must demonstrate worker registration, exact adapter ID selection, authenticated relay echo of opaque binary frames, and session closure. It is a GPU-free test and must not rely on model downloads or installed third-party packages.

**Further gates:** public package format and publisher verification, operator installation transaction / rollback, isolated subprocess adapter and language-neutral IPC, resource controls and workload consumption ACK semantics, JavaScript + Python/C++ developer experience, and production integration acceptance (including PostgreSQL where relevant).
