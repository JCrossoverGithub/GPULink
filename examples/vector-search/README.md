# DEV-06 — independent GPU vector search application

A small standalone application performing top-k inner-product retrieval over supplied quantized vectors. It is not an embedding generator, a vector database, a performance benchmark or a production search service. It intentionally uses the existing 32 KiB batch payload boundary, up to 64 items, 64 dimensions, integer components in [-100,100], topK <= 10. No CPU fallback: the workload requires the worker-selected CUDA UUID and exactly one visible CUDA device. Double-precision matrix-vector multiplication yields exact bounded integer sums. Stable descending-score, ascending-ID ordering is applied to the returned scores. The client independently checks the result using integer arithmetic.

## Prepare

Requires Node 24+, npm, Bash, Python 3 and the trusted, previously verified DEV-05 delivery extracted from revision `6220a093d5a70abd8d735df2d51163315dc67090`. No source checkout required. `prepare.sh` checks the accepted manifest revision and package bytes, creates two fresh independent projects, installs local SDK tarballs offline, uses the public Adapter SDK CLI to generate the starter, replaces only `run(payload)`, packs and inspects it, and runs local client tests. The destination must not exist. If preparation fails, inspect the output; use a fresh destination on retry. This starts no GPULink services, installs no Python dependencies and approves no workload. One isolated mock HTTP server is used by the tests; it is not a GPULink deployment.

```sh
sha256sum -c SHA256SUMS
bash prepare.sh /absolute/verified/extracted "$HOME/gpulink-dev06-vector-search"
```

The project contains `author-project/author`, `author-project/bundle`, and `client-project` (with its own package and client SDK). The sample expects audio:95, video:93, render:88. A fifth test uses mock HTTP responses solely to test the application/SDK boundary. None of these tests establishes physical GPU execution.

## GPU operator

Use only a new, independently installed worker profile and the matching CLI from the verified distribution. Review the bundle program and a trusted CUDA PyTorch virtual environment, then use the installed Adapter SDK's `prepare-python --bundle ... --interpreter ... --out ...` (optionally `--library-path /usr/lib/wsl/lib` for WSL). Review the resulting launcher and catalog before computing its digest and explicitly approving it with the existing stopped-worker `worker approve-catalog` command. No automatic approval or runtime installation is performed by this app. Server and worker onboarding use existing supported GPULink procedures. Keep the approved paths protected and unchanged. Credentials are provided by the operator, not embedded in the application or workload.

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

## Scope and next gate

No Core change. Local development used reconstructed SDK tarballs, Node 22 and CPU-only PyTorch; SDK tooling emits an engine warning outside Node 24. Author scaffolding, package inspection, independent reference tests, mock HTTP integration and refusal of CPU execution were checked locally. The accepted-main artifact, Node 24, actual remote execution and operator experience remain the acceptance gates on the target machines. Do not use prior retired credentials or installation profiles.
