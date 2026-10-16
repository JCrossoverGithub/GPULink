# DP3 — independent adapter package and operator catalog preview

**Status: scoped packaging workflow accepted on JPCMAIN, October 16, 2026.**
This describes `@gpulink/adapter-sdk@0.1.0` developer tooling. It remains intentionally **private**,
not a public stable v1 SDK, signed publisher system, full dependency closure or
safe untrusted workload installer. No Core runtime, scheduler, protocol, or
catalog schema change is introduced by this work.

## Boundaries

A developer creates a one-file GLIP v1 program, plus a versioned metadata recipe,
**outside the GPULink repository**. The SDK creates a relocatable directory with
that program and a SHA-256 lock. A separate operator *reviews* its bytes, licenses,
dependencies and declared capability, selects an approved runtime executable,
then generates a candidate entry in the **existing** operator catalog schema v1.

Neither `pack`, `inspect`, nor `catalog` launches the worker, changes an existing
catalog, enables a worker, installs software, validates GPU correctness, or
authorizes a client to execute arbitrary code. Only the trusted worker's existing
operator-configured catalog loader can activate a reviewed entry. Calling
`inspect` checks self-consistency, **not publisher identity**; anyone can rewrite
both the program and its lock. The operator must retain an independently approved
artifact digest and protect their installed files and parent directories.

## Independent developer — Python echo example

The author directory is a separate project, not a GPULink Core module:

```
author/
  gpulink.adapter.json
  echo.py
```

Copy `examples/external-adapter/gpulink.adapter.example.json` to
`author/gpulink.adapter.json` and copy `echo-subprocess.py` to `author/echo.py`.
The recipe uses existing `adapterManifest.schemaVersion:2` fields and declares a
single root-level `entry`. Only the current `explicit-text-v1` completion mode,
if present, is accepted. No public Core API, worker path, or host runtime path is
recorded inside the source package.

The SDK can be used from its package directory or from a **separately installed
npm tarball**. From any working directory with its CLI available:

```bash
node /path/to/sdk/bin/package.mjs pack \
  --source /absolute/author --out /absolute/new-bundle
node /path/to/sdk/bin/package.mjs inspect \
  --bundle /absolute/new-bundle
```

The output directory is created only if it does not already exist:

```
new-bundle/
  gpulink.adapter.lock.json
  echo.py
```

The lock contains an immutable adapter identity/version/GLIP execution mode,
package schema version, entry filename and its SHA-256. The format is stable for
equivalent recipes and bytes, independent of the machine's absolute paths.
The SDK rejects traversal, symlinks, oversized files, malformed recipe fields,
extra bundle files, and modified entry contents. This initial candidate supports
one program file (at most 4 MiB), not a complex model or native dependency tree.

## Operator — review, stage, generate candidate and opt in

The operator copies the developer bundle to a controlled host directory, runs
`inspect` there, reviews its manifest and SHA-256 against a separately trusted
source, and checks the workload's real dependency/license risks. For a trusted
Python GLIP subprocess:

```bash
umask 077
node /path/to/sdk/bin/package.mjs catalog \
  --bundle /operator/approved/echo-v1 \
  --interpreter /usr/bin/python3 \
  > /operator/private/reviewed-catalog-candidate.json
```

The executable must be an absolute path to a regular, owner/root-controlled file,
up to 64 MiB; system interpreter symlinks are resolved before hashing. `catalog`
produces the **existing** catalog JSON (`schemaVersion:1`) with the exact v2
manifest, the executable SHA-256, fixed `['-I','-B',entry]` arguments and the
program asset hash. `catalog-direct` can preview a single executable file as the
program instead of a Python interpreter, without introducing a new runtime.

**Review before installation.** The operator must explicitly merge/adopt the
candidate into their own private, root- or worker-owned catalog (mode 0600,
protected parent directories), set
`GPULINK_APPROVED_SUBPROCESS_CATALOG_PATH` on an authorized worker, and perform
the existing readiness and session checks. Multiple adapters require an
operator-reviewed merge into the existing `adapters` array. The tool does not
automatically activate, merge, approve, restart, deploy, or grant GPU access.
Deleting the approved catalog entry and restarting/reconfiguring the worker
prevents new admissions; existing leases/processes need separate revocation and
termination handling. A revoked asset must not be treated as cleaned up solely
because its entry is removed.

## Proof and limitations

**Accepted on JPCMAIN (October 16, 2026, Node 24):** `npm --prefix
packages/gpulink-adapter-sdk test` passed **7/7**; the independent offline
package/loader/revoke gate passed **1/1**; existing focused IPC/subprocess
regressions passed **54/54**; `npm run check` passed **491/525** with **34
PostgreSQL-dependent skips** and zero failures; Client SDK build and **33/33**
tests passed. The candidate had ten changed paths and no Core, worker,
scheduler, broker, or protocol modifications. These results do not constitute
public SDK release or production operator installation.

- `node --test packages/gpulink-adapter-sdk/spec/package-workflow.test.mjs`
  checks repeatable locks, external echo conformance, mutation/schema/symlink
  rejection, candidate generation and CLI failures.
- `node --test scripts/acceptance/external-adapter-package.gate.mjs` is an
  explicit independent npm tarball consumer gate: pack offline, install SDK in
  a disposable directory, create a new external author package, generate an
  operator catalog and load it with the existing worker loader. Tampering
  invalidates readiness, and removal of the catalog entry disables admission.
- The prior accepted `external-client-approved-adapter.gate.mjs` and
  `real-gpu-approved-adapter.gate.mjs` cover transport and physical CUDA paths
  separately. Packaging does **not** imply these gates were rerun here.

No automated external code installation, publishing, signed provenance,
transitive Python/native/model dependency closure, containment, process-tree
reaping, GPU isolation, or safe fence release is claimed. No client can choose
an interpreter, entrypoint, raw GPU or executable from the session API.

This is one incremental author-to-operator workflow, not complete DP3 or a
generalized multi-file packaging ecosystem. Extend only when a concrete GPU
workload forces a justified package format change.
