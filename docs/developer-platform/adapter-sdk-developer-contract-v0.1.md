# Adapter SDK developer compatibility contract — experimental v0.1

**Status: scoped JPCMAIN acceptance on October 16, 2026; experimental pre-v1.**
Applies to the intentionally private `@gpulink/adapter-sdk@0.1.0` developer
*toolkit*, not a published v1 library. Supersedes **no** existing wire,
manifest, operator or scheduler contracts. This milestone makes existing
compatibility boundaries explicit.

## The independent developer's minimal workflow

1. Implement the language-neutral **GLIP v1** protocol in the language chosen
   for the workload. A supplied Python echo implementation is an example only:
   normal models do not echo bytes. A GLIP READY confirms the transport
   handshake, **not** the model-loaded signal, audio-consumption credit, or
   successful workload completion.
2. Create `gpulink.adapter.json` with `schemaVersion:1`, a v2 manifest,
   one root-level program `entry`, and optionally `completionMode` equal to
   `explicit-text-v1`. See the accepted
   [package workflow](operator-trusted-adapter-package-workflow.md).
3. Use the separately installed author toolkit to check compatibility, run the
   **echo-only** conformance profile if applicable, `pack`, and `inspect`.
   Workload-specific streams must define and test their own controls, readiness,
   consumption and completion. A successful echo test does not certify ASR.
4. Deliver the bundle out of band to a trusted operator. They independently
   verify the approved artifact identity and dependencies, select an installed
   runtime and review the proposed catalog entry. SDK tools never activate it.
5. A separately installed `@gpulink/client` application uses the authenticated
   GPULink data plane. A client cannot provide executable paths or pick a GPU.

## Supported npm imports and commands (pre-v1)

| Public package subpath | Developer surface | Stability |
|---|---|---|
| `@gpulink/adapter-sdk` | `GLIP_V1`, `encodeGlipV1`, `decodeGlipV1`, `runEchoConformance` and `EchoConformanceError` | Experimental; **echo fixture**, not generic stream supervisor |
| `@gpulink/adapter-sdk/package` | `packAdapter`, `inspectAdapter`, `operatorCatalogCandidate`, `AdapterPackageError`, `PACKAGE_FILE_NAMES` | Experimental single-file package and catalog *preview* |
| `@gpulink/adapter-sdk/contract` | `ADAPTER_SDK_COMPATIBILITY`, `assertAdapterCompatibility`, `AdapterCompatibilityError` | Experimental version declaration and comparison only |

CLI names `gpulink-adapter-conformance` and `gpulink-adapter-package` are
provided in the npm tarball. `gpulink-adapter-package` verbs are `pack`,
`inspect`, `catalog` and `catalog-direct`, as documented in the package README.
Node >=24 is the **author toolkit** support floor; Python/C++ adapter processes
are not required to execute Node code. Install tooling from a controlled build
or locally packed tarball until a release decision is approved.

The version comparison surface requires **exactly** these declaration fields:

```js
import {assertAdapterCompatibility} from '@gpulink/adapter-sdk/contract';

assertAdapterCompatibility({
  protocol:'gpulink.adapter.ipc',
  ipcVersion:1,
  manifestSchemaVersion:2,
  packageSchemaVersion:1,
  executionMode:'streaming-gateway',
  completionMode:'explicit-text-v1',
});
```

This does not validate an adapter implementation, manifest identity or SHA-256,
prove author authenticity, grant admission, or run external code. It rejects
unknown/missing fields and unsupported major version fields without fallback.

| Boundary | Supported version | Distinct error codes |
|---|---|---|
| GLIP protocol | `gpulink.adapter.ipc` / v1 | `unsupported_ipc` |
| Adapter manifest | `schemaVersion:2` | `unsupported_manifest` |
| Portable package recipe/lock | `schemaVersion:1` | `unsupported_package` |
| Execution mode | `streaming-gateway` | `unsupported_execution_mode` |
| Completion mode | `explicit-text-v1` | `unsupported_completion_mode` |
| Declaration shape | Exact fields only | `invalid_declaration` |
| Operator catalog | `schemaVersion:1` | Independently checked by existing operator loader; **not** by this function |

`AdapterCompatibilityError.code` is bounded, and failures always throw. The
separate packaging API raises `AdapterPackageError.code` (e.g.
`artifact_digest_mismatch`, `unexpected_bundle_files`, `invalid_package_descriptor`,
`unsafe_operator_file`); conformance uses `EchoConformanceError.code`. Version
compatibility does **not** implicitly approve package integrity or code trust.

## Versioning policy and what would break compatibility

- SDK `0.1.x` is **pre-1.0 and private**. No general SemVer public stability
  promise, public registry publication, or browser/Python/.NET SDK parity.
- A wire-frame or handshake behavior change needs a separately reviewed GLIP
  contract version; a manifest shape change needs a reviewed schema revision.
  Neither follows automatically from the npm package version.
- Existing package and catalog schemas remain v1. Introducing multi-file
  dependencies or different process trust levels requires separate review and
  acceptance; new major formats must never be silently accepted as v1.
- On a later approved SDK release, its supported Node versions, exports, CLI
  flags, error codes, schema compatibility matrix, deprecation policy and
  package reproducibility must be explicitly recorded and tested.
- The Client SDK is **separately versioned** and never inherits this SDK's
  release status. Core remains independent of both developer installations.

## Accepted JPCMAIN evidence and limits — October 16, 2026

At the accepted source baseline `b2510d4c51acbc6eff984a0fc8e6f5ecdaf192bf`
plus this nine-file candidate, the guarded JPCMAIN WSL/Node >=24 gate passed:

- Author SDK `npm --prefix packages/gpulink-adapter-sdk test`: **10/10** passed,
  including version compatibility/unknown-field rejection.
- Independent npm author package gate
  `node --test scripts/acceptance/external-adapter-package.gate.mjs`:
  **1/1** passed with the `./contract` export and unchanged operator loader.
- Existing IPC/subprocess focused tests: **54/54** passed.
- Opt-in packaged real-GPU end-to-end test
  `node --test scripts/acceptance/real-gpu-approved-adapter.gate.mjs`:
  **1/1** passed. The separate author SDK tarball packaged a single CUDA
  Python program, and a separately packaged Client SDK app received prediction
  `15.5` through the existing operator-approved worker and relay. The GPU
  operation reported `executionMs: 0.0143` (not end-to-end latency).
- `npm run check`: **494/528** passed, **34 optional PostgreSQL-dependent
  skips**, zero failures. Client SDK TypeScript build passed and client tests
  passed **33/33**. The skipped PostgreSQL cases were **not executed**.

The physical GPU gate requires explicit opt-in with
`GPULINK_REAL_GPU_PACKAGE_ACCEPTANCE=YES_PACKAGED_LOCAL_OPERATOR_TRUSTED`, the
previous `GPULINK_REAL_GPU_ACCEPTANCE`, and the trusted operator-selected
Python/CUDA runtime. Its bundle lock is checked, and the existing scheduler
allocation and authoritative session release are asserted. The operator's
launcher and Python/CUDA dependencies are **outside** the single-file bundle
and remain separately trusted. This is the limited evidence accepted in the
commit containing this record, not an automatically approved operator install.

No production deployment, public publishing, signed provenance, complete
native/model dependency closure, sandbox, process-tree ownership, GPU
isolation, safe fence release, pretrained model readiness, or untrusted-tenant
admission is claimed. The independently packaged deterministic CUDA workload
is **not pretrained ASR**. DP3 and public Adapter SDK v1 remain incomplete.
