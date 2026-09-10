# GPU Benchmark Workload

## Purpose

`benchmark.gpu` proves GPUlink can safely schedule and execute real CUDA work
before model, audio, or artifact complexity is introduced. It measures a fixed
float32 matrix multiplication on one exclusively leased GPU.

This is deliberately not a general benchmark launcher. A job cannot choose an
executable, script, module, backend, data type, environment variable, or file.

## Contract

```json
{
  "type": "benchmark.gpu",
  "constraints": {
    "gpuCount": 1,
    "minVramMiB": 4096,
    "capabilities": ["benchmark.gpu"]
  },
  "payload": {
    "schemaVersion": 1,
    "matrixSize": 4096,
    "warmupIterations": 3,
    "measuredIterations": 10
  }
}
```

Bounds:

- `schemaVersion`: exactly `1`
- `matrixSize`: `1024`, `2048`, `4096`, or `8192`
- `warmupIterations`: integer from 1 through 10
- `measuredIterations`: integer from 1 through 25
- unknown payload fields: rejected

The shown values are defaults. The control plane stores the normalized payload,
and the worker validates it again before launch.

## Runtime

The WSL installer creates an isolated virtual environment at:

```text
/opt/gpulink/runtime/benchmark
```

It pins PyTorch 2.12.1 and the CUDA 13.0 wheel. PyTorch lists that combination
in its [official installation matrix](https://pytorch.org/get-started/previous-versions/).
NVIDIA documents CUDA 13.x minor-version compatibility for driver 580 and newer
in the [CUDA release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/).

After the current worker source has been installed under `/opt/gpulink`, run:

```bash
sudo ./scripts/install-benchmark-runtime-wsl.sh
```

The installer is repeatable. It recreates an incomplete virtual environment,
verifies `pip`, and verifies a real CUDA allocation and synchronization as the
restricted `gpulink` user. It adds `benchmark.gpu` to the root-readable worker
environment only after that health probe succeeds, then restarts the worker
service. No GPUlink credential is required by the benchmark-runtime installer.

## Submission

With the client URL and credential already loaded securely:

```bash
npm run cli -- submit-benchmark
npm run cli -- submit-benchmark 4096 3 10
npm run cli -- wait <job-id>
```

## Safety behavior

- one repository-owned Python script and one configured interpreter path;
- argument-array launch with no shell;
- shared bounded-process lifecycle controls with benchmark-specific errors;
- exact numeric validation at control-plane and worker boundaries;
- leased GPU selected through `CUDA_VISIBLE_DEVICES` by UUID;
- minimal child environment with no GPUlink credentials;
- 64 KiB stdout and stderr limits;
- 60-second execution timeout by default, capped at 120 seconds by config;
- process-group termination on timeout or cancellation;
- exactly one JSON object accepted from the runner;
- fixed output schema cross-checked against the request;
- `benchmark.gpu` advertised only after a successful runtime health probe.

## Physical acceptance

1. Verify both workers advertise `benchmark.gpu`.
2. Drain the desktop and complete a small benchmark on the laptop.
3. Resume the desktop, drain the laptop, and complete the same benchmark.
4. Resume both and submit two benchmarks close together; verify one lands on
   each GPU and both complete.
5. Cancel or interrupt a long-enough benchmark and confirm bounded cleanup and
   lease recovery/failure behavior.
6. Confirm each GPU still has at most one active job.
7. Confirm neither worker has an inbound GPUlink listener.
