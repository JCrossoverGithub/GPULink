# DP3 real-GPU integration — accepted operator-trusted scope (2026-10-16)

**Base source checkpoint:** `36f1cdcd99ffa2f387d7f5d5a410a4537e39bd5a` on
`feature/phase6a-streaming-asr-foundation`.

## Goal and limited claim

One **operator-trusted**, external Python GLIP v1 workload performs a fixed
PyTorch CUDA neural-network forward pass on the physically inventoried,
scheduler-assigned NVIDIA GPU. An independently packed `@gpulink/client`
application requests the capability, waits for workload-specific model
readiness, sends fixed binary input, verifies numerical results and an execution
event, requests explicit completion and releases the authoritative session.

This gate uses a **local ephemeral control plane** and a **real NVIDIA GPU**;
no fake GPU is supplied to the worker. It is NOT a pretrained model acceptance,
complete public Adapter SDK conformance, production workload launch,
supply-chain verification, or untrusted-tenant security certification.

## Verified acceptance evidence (JPCMAIN, October 16, 2026)

**Accepted scope:** one real, physically inventoried RTX 3090 Ti was scheduled
for a trusted external subprocess through the unchanged GPULink Core/Client
SDK session and GLIP protocols. The Python workload loaded and warmed a tiny
fixed PyTorch CUDA neural network, emitted its distinct model-ready event,
returned the verified prediction `15.5`, and acknowledged completion. The
session's `session.allocated` event identified the physical GPU; after the
client closed it, the persisted session had no assigned GPU or worker.

- `node --test scripts/acceptance/real-gpu-approved-adapter.gate.mjs`:
  **1/1 passed**, prediction `15.5`, reported warmed CUDA operation `0.17 ms`
  (not an end-to-end latency benchmark).
- `npm run check`: **487 passed, 34 PostgreSQL-dependent skipped, 0 failed**
  out of 521 tests; separate explicit GPU test is intentionally opt-in.
- `npm --prefix packages/gpulink-sdk test`: **33/33 passed**.
- Focused IPC, subprocess supervisor and approved-adapter tests: **54/54 passed**.
- Environment: JPCMAIN WSL2, Node.js 24.19.0, Python 3.12.3,
  PyTorch 2.12.1+cu130, NVIDIA RTX 3090 Ti (driver 610.88).
- Accepted source baseline: `36f1cdcd99ffa2f387d7f5d5a410a4537e39bd5a`
  plus the eight candidate paths. The integration commit is the Git commit
  containing this evidence and the eight source/test/doc paths; its SHA is
  available through `git log -- docs/developer-platform/real-gpu-approved-adapter-gate.md`.
  No push, deployment, model download or package installation was performed
  during the acceptance test.

This is a scoped integration qualification, not the complete DP3/DP6 product
milestone, general dependency pinning, or a production/trusted-tenant isolation
claim. Retain the limitations documented below.

## Existing contracts reused

- Public Client SDK: `@gpulink/client` installed as an npm tarball outside repo
- Existing v2 adapter identity/capability and operator-pinned subprocess catalog
- Unchanged GLIP v1 frame format and explicit-text-v1 completion protocol
- Worker-assigned GPU UUID passed from the trusted session context to
  `CUDA_VISIBLE_DEVICES` in the subprocess supervisor (never client controlled)
- **GLIP READY** only means IPC startup; `example.gpu.model.ready.v1` is sent
  after the real GPU model loads, warms up and synchronizes
- CUDA workload: fixed PyTorch `Linear(4,2) → ReLU → Linear(2,1)`, deterministic
  weights; binary big-endian float32 request `[1,2,3,4]` returns `15.5`

Only an authentic-looking NVIDIA GPU UUID from the worker's authoritative
inventory is eligible for the subprocess's CUDA visibility hint. Fake GPU UUIDs
still support existing echo regressions, but CUDA workloads fail closed without
an assigned physical UUID. CUDA_VISIBLE_DEVICES is **a cooperative selection
hint, never GPU security isolation or an authorization grant**.

## Operator prerequisites / acceptance command

On a **dedicated, explicitly authorized test worker**, ensure the GPU is not
being used by another workload. Local Node.js >=24, system nvidia-smi, Python
with functioning PyTorch CUDA, and existing npm dependencies are required.
No model downloads or new packages are required. Python environment location is
supplied by the operator; **no WSL, hostname, CUDA version, runtime path or GPU
model is hardcoded in Core**.

```bash
# From repo root after a documentation/source-only patch application.
export GPULINK_REAL_GPU_ACCEPTANCE=YES_LOCAL_OPERATOR_TRUSTED
export GPULINK_ACCEPTED_GPU_PYTHON=/absolute/path/to/existing/cuda/python
# Optional, only if this host's driver libraries are not in loader paths:
# export GPULINK_OPERATOR_CUDA_DRIVER_DIR=/absolute/operator-approved/driver/lib

npm --prefix packages/gpulink-sdk run build
node --test test/adapter-subprocess-supervisor.test.mjs \
  test/adapter-ipc-v1.test.mjs test/approved-subprocess-adapters.test.mjs
node --test scripts/acceptance/real-gpu-approved-adapter.gate.mjs
npm run check
npm --prefix packages/gpulink-sdk test
```

The gate uses only disposable author and client directories, a loopback control
plane, runtime-generated operator catalog with exact SHA-256 hashes, physical
GPU worker discovery, and an external installed client package. It explicitly
opts in to physical compute, does not commit or deploy, and cleans temporary
files/processes on its normal success/failure path.

## Acceptance before marking complete

1. Physical GPU UUID inventoried by worker and recorded on the session; one
   physical GPU present for this first acceptance environment.
2. GLIP subprocess launched through the existing approved catalog; trusted
   device selection cannot be supplied by client JSON, manifest or messages.
3. PyTorch confirms one visible CUDA GPU; model-ready only after successful
   forward/sync, not merely relay pairing or GLIP READY.
4. `@gpulink/client` is packed and installed into an independent application;
   its binary request returns the numerically expected float32 output.
5. Successful explicit END, worker acknowledgment only after child exit zero,
   authoritative close, clean worktree and passing current regression suites.
6. Record test log, Node/Python/PyTorch versions, physical GPU and exact accepted
   source commit in `verified-milestone-status.md` **after JPCMAIN passes**.

## Known limitations — do not promote to production

- The interpreter path in an operator-generated pinned launcher may be a venv
  symlink. `torch`, CUDA libraries and all imported native dependencies are not
  transitively pinned by the existing 4 MiB/file assets catalog.
- CUDA_VISIBLE_DEVICES is an NVIDIA/CUDA selection convention, not container
  isolation. Malicious trusted-process code could ignore it and may access
  files, other GPUs or process state permitted by the host.
- The current subprocess supervisor is process-based, not process-tree/OCI
  isolated. No general-purpose GPU memory quota or safe automatic fence
  release can be inferred from process termination.
- The existing generic supervisor has a fixed 30-second session lifetime;
  larger model initialization may require a separately reviewed, bounded
  workload policy. This example intentionally stays very small.
- This example is a deterministic synthetic neural network, **not** Parakeet,
  ASR, LLM, or another pretrained production model.
- GPU timing metadata measures a tiny warmed forward pass, not end-to-end
  network latency, real workload throughput or a reproducible benchmark.
