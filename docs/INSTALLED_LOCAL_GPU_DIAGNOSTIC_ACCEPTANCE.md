# Installed local GPU diagnostic — opt-in acceptance

**Scope:** one real, bounded GPU-status diagnostic through the **source-built, privately installed** GPULink CLI. This is a **Linux/WSL developer acceptance**, not a production deployment, remote-cluster test, benchmark, or automatic CI requirement.

The gate validates the complete developer journey: build CLI artifact → install outside the repo → generate private localhost installation → start managed control plane → verify empty queue → start one managed GPU worker with explicit consent → schedule **exactly one** `diagnostic.gpu-status` job → verify authoritative completion, GPU UUID and scheduling → stop worker before control plane → restart control plane → retrieve durable SQLite job result → stop and clean up.

## Prerequisites and explicit consent

- Linux with the GPULink-managed Linux lifecycle available, Node.js **24+**, npm, Bash, Python 3, `timeout`, Git, and an operational `nvidia-smi` executable with access to at least one NVIDIA GPU. No host name, GPU model, GPU count or WSL path is hard-coded.
- A checked-out GPULink repository, with the command run from its root. Running the gate does not require modifying the checkout or publishing to npm; the script derives its root from its own checked-in location and checks Git state for unexpected changes.
- Local TCP port **127.0.0.1:8088** must be free. This is a limitation of the *generated localhost installation preset*, not of the distributed GPULink core. The script refuses an occupied port and will not stop the existing listener.
- Unset inherited GPULink service URLs and scoped authentication tokens before running. No credentials are printed.
- **Operator acknowledgement:** starting the worker allows it to accept assigned GPU work. The fresh, isolated installation has an empty queue and the gate submits one diagnostic, but explicit consent is still required.

From the repository root:

```bash
GPULINK_E2E_DIAGNOSTIC_ACK=YES_ALLOW_ONE_BOUNDED_GPU_DIAGNOSTIC \
  bash scripts/acceptance/installed-local-gpu-diagnostic.sh
```

This gate is never invoked by the normal `npm test`/`npm run check` CI workflow. The automated `test/installed-local-gpu-diagnostic-gate.test.mjs` tests **only** script syntax, policy structure and refusal without consent; they never launch a GPU worker.

## Expected result and boundaries

A passing run reports one online worker with one or more physical GPUs, a single submitted diagnostic job, authoritative `succeeded` status, a GPU UUID consistent with the scheduler assignment, successful worker-first shutdown, and the same persisted job after a control-plane restart. Successful final cleanup reports `PASS: All checks passed; confirmed stopped; disposable installation removed.`

This diagnostic queries GPU status through the `nvidia-smi`-backed GPULink workload path; it does **not** establish throughput, ML inference performance, CUDA kernel correctness, model streaming quality, or multi-machine cluster readiness. A separate operator-controlled gate is necessary for those capabilities.

## Failure behavior and recovery

The script refuses missing or incorrect consent **before creating any installation**. It checks required tooling, an accessible NVIDIA GPU, inherited profile settings, and local port availability before launching services. All test credentials, SQLite state, and JSON results stay inside a private `mktemp` directory outside the Git checkout.

On exit, it requests shutdown **only** through the installed CLI's verified, installation-owned supervisor IPC: worker first, then control plane. It never sends signals to a PID copied from an ownership file. If the run fails, any ownership artifact remains, or TCP listening state cannot be proven clear, the temporary installation is **preserved** and the gate exits unsuccessfully. Read the printed path, inspect the state, and do not blindly delete records or kill processes. No automatic orphan adoption or recovery is performed.

No AWS resources are accessed, no GPU benchmark or adapter session is submitted, and no npm package is published. Production operations, Windows-native lifecycle, and remote GPU enrollment are out of scope.
