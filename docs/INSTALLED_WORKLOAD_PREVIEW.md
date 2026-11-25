# DEV-04A — operator-approved external GPU workloads

This increment connects the existing GLIP v1 subprocess/session backend and
private Adapter SDK package workflow to the **installed remote-worker CLI**.
It does not introduce a scheduler, generic batch-job API, runtime or protocol.
The earlier October 16 physical local CUDA acceptance remains valid for its
original scope; cross-host installed workload acceptance for this increment
is pending.

## Roles and trust boundary

- Author: creates a one-file program and `gpulink.adapter.json` outside Core.
- Operator: reviews source, dependencies, license and manifest, stages a
  package in protected Linux storage, chooses a local executable and approves
  a catalog with an independently reviewed digest. The operator owns all
  directories and files referenced by the catalog, including their parents.
- Client: requests the registered capability and adapter identity through the
  existing authenticated session API. It does not select an executable, shell,
  file path, raw GPU UUID, runtime environment or arbitrary code.

The catalog loader validates the approved executable and assets against their
hashes. Hashes are integrity checks, not signatures or dependency closure.
The subprocess runs as the worker UID, not in a hostile-code sandbox. Do not
approve untrusted code. GPU visibility is a cooperative placement hint, not
hardware isolation. Python, native libraries, drivers and dependencies remain
operator-managed and are not transitively pinned by this package format.

## Install or remove an approved catalog

On an already enrolled, **stopped** Linux/WSL remote worker, use the existing
Adapter SDK `gpulink-adapter-package pack`, `inspect`, and `catalog` workflow
(see [package guide](developer-platform/operator-trusted-adapter-package-workflow.md)).
The catalog is the same schema v1 used by the existing Core worker loader.
Review every manifest, executable, argument, asset, hash and dependency before
approval. Keep the candidate private (mode 0600) and obtain its SHA-256 from the
reviewed bytes, not from an untrusted sender.

```sh
gpulink --config-dir "$HOME/.gpulink/work-w" worker approve-catalog \
  --file /absolute/private/reviewed.json --sha256 REVIEWED_SHA256

gpulink --config-dir "$HOME/.gpulink/work-w" worker doctor --live --gpu
gpulink --config-dir "$HOME/.gpulink/work-w" worker start --accept-assigned-work
```

Approval validates the existing catalog loader without launching an adapter;
it copies the approved catalog to `approved-subprocess.json` inside the private
installation. It refuses overwrite, symlinks, unsafe permissions, conflicting
lifecycle lock, existing worker ownership record/socket and mismatching digest.
The supervisor supplies only this fixed installation-owned catalog path to the
worker; inherited catalog variables are not used. No catalog is configured by
default. Enrollment, credentials, installation identity and diagnostic adapters
are unchanged. Doctor validates catalog and pinned assets, not actual CUDA or
model readiness. The worker loader also validates at start. Never edit catalog
or assets while running. Do not place private files in the source checkout.

For a planned change, drain the worker and close all sessions/finish jobs,
then stop it using the existing worker lifecycle. Once stopped:

```sh
gpulink --config-dir "$HOME/.gpulink/work-w" worker clear-catalog
```

This removes the approval, not workload assets, and is not a running-session
revocation or process-tree cleanup guarantee. Approve the replacement catalog
explicitly before restarting. Status and stop do not depend on valid workload
assets, so an asset mutation cannot prevent managed shutdown.

## First physical computation — bounded matrix transformation

The separate author example `examples/external-adapter/matrix-transform/`
implements GLIP v1 in Python with no GPULink imports. It requires an existing
operator-approved PyTorch CUDA environment. The application uses the private
installed `@gpulink/client` package and requests `example.cuda.matrix` /
`example.cuda.matrix.v1`, with at least 1000 MiB available VRAM. The workload
only accepts a 16-byte big-endian float32 2x2 matrix with finite entries of
absolute value at most 16. It performs a CUDA matrix multiplication with
[[2,3],[-1,4]], synchronizes, and returns four big-endian floats plus execution
metadata. For input [[1,2],[3,4]], the expected result is [[11,16],[11,14]].
It refuses unavailable CUDA, multiple visible devices, invalid input or absent
worker-assigned GPU UUID. No CPU fallback, downloads or model weights. GLIP
READY is IPC readiness; a separate event confirms warm CUDA readiness.

The operator must choose a real CUDA-enabled Python environment. If the
interpreter is a virtual environment symlink or requires WSL's driver library
path, the existing reviewed launcher pattern in
`real-gpu-approved-adapter.gate.mjs` is appropriate: hash-pin a small shell,
launcher and program; have the launcher `exec` the selected venv interpreter
with `-I -B` and a fixed, reviewed library path. Do not silently resolve a venv
interpreter into system Python and assume its packages are available. No
runtime installation is done by this increment.

Use a fresh DEV-03B managed server and fresh worker profile; do not reuse the
previously disclosed test invitation credential. Install the same candidate
on both hosts. Join without assignment consent, approve the reviewed catalog,
then start the worker explicitly. On the server host, run the matrix client
from an independent directory using only the client SDK tarball and client-role
credentials, not worker/admin credentials. Its loopback API requests allocate
a remote GPU session and the managed HTTPS relay carries data to the worker.
The external client example checks CUDA-ready, the numerical result, execution
metadata, explicit completion and released session ownership. Server inventory
and persisted allocation evidence must identify the expected physical GPU.
Drain/stop and clean up with existing managed LAN workflow.

## Acceptance boundary

GPU-free CI verifies approval/removal, digest and asset mutation refusal,
non-overwrite, lifecycle locking and installed entry points. Physical CUDA
execution is explicitly opted in, not part of default CI. Acceptance requires
the separately packaged client and author package, same installed CLI artifact,
real cross-host GPU computation, numerical validation and session release.
Cancellation/timeout use the existing GLIP session supervisor; this increment
does not claim new physical cancellation acceptance, arbitrary custom finite
jobs, full dependency packaging, multi-tenant isolation or stable SDK release.
