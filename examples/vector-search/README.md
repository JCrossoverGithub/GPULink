# DEV-06 — independent GPU vector search application

A small standalone application performing top-k inner-product retrieval over supplied quantized vectors. It is not an embedding generator, a vector database, a performance benchmark or a production search service. It intentionally uses the existing 32 KiB batch payload boundary, up to 64 items, 64 dimensions, integer components in [-100,100], topK <= 10. No CPU fallback: the workload requires the worker-selected CUDA UUID and exactly one visible CUDA device. Double-precision matrix-vector multiplication yields exact bounded integer sums. Stable descending-score, ascending-ID ordering is applied to the returned scores. The client independently checks the result using integer arithmetic.

## Prepare

Requires Node.js 24+, npm, Bash, Python 3 and `sha256sum`. Obtain this example
folder from the repository (or download the source archive and extract the
folder); no Core build is required. The registry path uses the published SDKs
and checks their integrity against the November 27 release. Preparation
creates separate author and client projects, generates and packages the
CUDA-only adapter, and runs five reference/client tests. It starts no GPULink
services, installs no Python dependencies and approves no workload.
The destination must be an absolute, nonexistent path.

```sh
bash prepare.sh --registry "$HOME/gpulink-vector-search"
```

For original November 25 offline reproduction, use the [original example at
its accepted revision](https://github.com/JCrossoverGithub/GPULink/tree/6220a093d5a70abd8d735df2d51163315dc67090/examples/vector-search)
with the accepted DEV-05 delivery. The current script retains the original
offline mode, `bash prepare.sh /absolute/verified/extracted /absolute/new-project`,
which checks that original revision and its package hashes.

The project contains `author-project/author`, `author-project/bundle`, and `client-project` (with its own package and client SDK). The sample expects audio:95, video:93, render:88. A fifth test uses mock HTTP responses solely to test the application/SDK boundary. None of these tests establishes physical GPU execution.

## GPU operator

Use only a new, independently installed worker profile and the public CLI `npm install -g @gpulink/cli@0.1.0`. Review the bundle program and a trusted CUDA PyTorch virtual environment, then use the installed Adapter SDK's `prepare-python --bundle ... --interpreter ... --out ...` (optionally `--library-path /usr/lib/wsl/lib` for WSL). Review the resulting launcher and catalog before computing its digest and explicitly approving it with the existing stopped-worker `worker approve-catalog` command. No automatic approval or runtime installation is performed by this app. Server and worker onboarding use existing supported GPULink procedures. Keep the approved paths protected and unchanged. Credentials are provided by the operator, not embedded in the application or workload.

## Client usage

With operator-provided `GPULINK_BASE_URL` and `GPULINK_CLIENT_TOKEN` in the environment (or an operator-owned private Node env file), run from `client-project`:

```sh
node search.mjs expected sample.json
node search.mjs submit sample.json UNIQUE_PERSISTED_REQUEST_KEY
# Save the returned job ID; the submit process exits.
node search.mjs wait JOB_ID sample.json
node search.mjs get JOB_ID
```

`wait` verifies successful completion, exact ranks, CUDA backend, one execution attempt and recorded GPU/worker assignment. It observes only; timeout does not cancel or resubmit. Use the original key for retrying the same logical submission. `cancel JOB_ID` is explicit and subject to the existing GPULink cleanup rules. Do not print client secrets or invite contents. The numerical check cannot by itself prove actual CUDA execution; use the physical worker assignment and reviewed CUDA-only source for the physical acceptance.

## Physical evidence

The [November 25 acceptance](../../docs/acceptance/independent-vector-search-2026-11-25.md)
used an independent application and a separate RTX 3090 Ti worker, with a
successful first attempt and the exact reference ranking. The [November 26
Manager acceptance](../../docs/acceptance/installed-manager-two-host-2026-11-26.md)
reused the unchanged workload and verified drain/resume. Those runs used
verified distribution archives; this registry preparation path does not change
workload or client code. A new public-registry preparation check does not by
itself establish physical execution. Use a fresh profile and new private
credentials for any new hardware run.
