# Your first external batch workload (public preview)

This guide assumes an operator has a GPULink server and Linux/WSL NVIDIA worker
installation. For a new deployment see [managed LAN onboarding](MANAGED_LAN_PREVIEW.md)
and [remote worker setup](REMOTE_WORKER_PREVIEW.md). Install the matching published Adapter SDK and Client SDK from npm. Node.js 24+ is required for the developer tools.
Python is an example workload language, not a platform requirement.

## 1. Author: write a function

In a new independent directory, install the Adapter SDK from npm (run the commands in that directory):

```sh
npm init -y
npm install @gpulink/adapter-sdk@0.1.0
```

<!-- gpulink-example: batch-init -->
```sh
./node_modules/.bin/gpulink-adapter-package init-batch --out author --type external.batch.scale
```

`author/workload.py` contains a single `run(payload)` function and the existing
GLIP v1 framing. The generated function is explicitly a CPU echo starter, not a
CUDA test. Replace only the function with your workload. For example, with an
operator-provided CUDA-enabled PyTorch environment:

<!-- gpulink-example: batch-function -->
```python
def run(payload):
    import math
    import os
    import re
    import torch
    values = payload.get("values")
    if (not isinstance(values, list) or not 1 <= len(values) <= 128
            or not all(type(v) in (int, float) and math.isfinite(v)
                       and abs(v) <= 1000 for v in values)):
        raise ValueError("invalid input")
    if (not re.fullmatch(r"GPU-[A-Fa-f0-9-]{32,64}", os.environ.get("CUDA_VISIBLE_DEVICES", ""))
            or not torch.cuda.is_available() or torch.cuda.device_count() != 1):
        raise RuntimeError("assigned CUDA device unavailable")
    with torch.inference_mode():
        result = (torch.tensor(values, device="cuda:0") * 2).tolist()
        torch.cuda.synchronize()
    return {"values": result, "backend": "pytorch-cuda"}
```

Use stdout only for protocol frames; diagnostics go to stderr. The worker
selects the GPU. A workload must synchronize GPU work before returning, may
not leave independent descendants, and must accept/return JSON objects no
larger than 32 KiB. Pack your source; this does not execute or approve it:

<!-- gpulink-example: batch-pack -->
```sh
./node_modules/.bin/gpulink-adapter-package pack --source "$PWD/author" --out "$PWD/bundle"
```

<!-- gpulink-example: batch-inspect -->
```sh
./node_modules/.bin/gpulink-adapter-package inspect --bundle "$PWD/bundle"
```

Transfer the portable `bundle` directory to the GPU operator through a trusted
channel. A hash check is integrity evidence, not proof of publisher identity.

## 2. Operator: review and approve

On the Linux/WSL GPU host, install `@gpulink/adapter-sdk@0.1.0` into an independent project. With the
bundle and a known, trusted Python runtime available, set `PYTHON` to its absolute interpreter path (for example `/absolute/venv/bin/python`):

<!-- gpulink-example: batch-prepare -->
```sh
./node_modules/.bin/gpulink-adapter-package prepare-python \
  --bundle "$PWD/bundle" --interpreter "$PYTHON" --out "$PWD/review"
```

For WSL installations whose runtime requires it, add the explicit option
`--library-path /usr/lib/wsl/lib`. No inherited library path is copied. This
writes `review/launcher.sh` and `review/catalog.json` in a **new** directory
and returns the catalog path and SHA-256. It does not launch Python, install
libraries or enable anything. The virtualenv invocation path is preserved;
the shell, launcher and program are hash-pinned in the existing catalog.
The interpreter and imported/native dependencies are operator-owned, not a
transitively locked runtime. Keep the bundle and review directories at the
reviewed locations; protect them against untrusted writers.

Read the program, launcher and catalog; independently review the Python
runtime and compare the catalog SHA-256 against the digest printed by `prepare-python` (the approved digest must correspond to the actual reviewed bytes). With the worker stopped
and any previous workloads safely drained/finished, explicitly approve:

```sh
gpulink --config-dir /absolute/worker worker approve-catalog \
  --file "$PWD/review/catalog.json" --sha256 REVIEWED_SHA256
gpulink --config-dir /absolute/worker worker start --accept-assigned-work
```

Substitute the reviewed digest and actual worker profile. Do not skip review or blindly approve an arbitrary catalog. A successful approval does not start or register the worker; the explicit start above does. Existing catalog
replacement requires the existing clear/review/approve workflow; this command
never silently merges or replaces an active catalog. Existing streaming,
direct executable and system Python package commands remain unchanged.

## 3. Application developer: submit and retrieve

On the application host, run `npm install @gpulink/client@0.1.0` in
an independent Node application. Use the operator-provided client endpoint
and client-role secret (not admin or worker credentials). HTTPS must be
trusted; HTTP is allowed only on exact loopback. Configure `GPULINK_BASE_URL`
and `GPULINK_CLIENT_TOKEN` privately. Save this as `submit.mjs` and run
`node submit.mjs YOUR_REQUEST_KEY`. Persist the request key before submission;
reuse it only for retries of that logical request:

<!-- gpulink-example: batch-submit -->
```js
import { GPULinkClient } from '@gpulink/client';
const requestKey = process.argv[2];
if (!requestKey) throw new Error('Provide a persisted request key');
const client = GPULinkClient.fromEnv(process.env);
const {job} = await client.submitJob({
  projectId: 'scale-example',
  type: 'external.batch.scale',
  constraints: {gpuCount: 1, minVramMiB: 1000},
  payload: {values: [1, 2, 3]},
  maxAttempts: 1,
}, {idempotencyKey: requestKey});
console.log(job.id);
```

Save the returned ID. In a later invocation of the application, call
`client.getJob(jobId)` to retrieve status and result, or wait for a terminal
record without using the operator CLI. Save this as `wait.mjs` and run
`node wait.mjs JOB_ID` with the returned ID:

<!-- gpulink-example: batch-wait -->
```js
import assert from 'node:assert/strict';
import { GPULinkClient } from '@gpulink/client';
const jobId = process.argv[2];
if (!jobId) throw new Error('Provide the submitted job ID');
const client = GPULinkClient.fromEnv(process.env);
const terminal = await client.waitForJob(jobId, { timeoutMs: 60_000 });
if (terminal.status !== 'succeeded') throw new Error(`Job ended: ${terminal.status}`);
assert.deepEqual(terminal.result.values, [2, 4, 6]);
assert.equal(terminal.result.backend, 'pytorch-cuda');
console.log(terminal.result);
```

A wait timeout (`JOB_WAIT_TIMEOUT`) or caller abort stops observation only;
it never cancels or resubmits a durable job. Retain the ID and reconnect
when needed. Only `cancelJob(jobId)` requests job cancellation.

The scale example should
return `[2,4,6]` with `backend: "pytorch-cuda"` **only after** you replace the
CPU starter with the example and execute successfully on a CUDA worker.
Persist a distinct idempotency key for each intended logical job. No need for
the application to remain connected while the job runs.

The existing [batch contract](EXTERNAL_BATCH_PREVIEW.md) and
[cleanup recovery](JOB_CLEANUP_SAFETY.md) govern cancellation and leases.
This is a trusted self-hosted preview, not a hostile-code sandbox. Native
Windows worker lifecycle, independent newcomer
acceptance and arbitrary multi-file dependency packaging are not claimed.
