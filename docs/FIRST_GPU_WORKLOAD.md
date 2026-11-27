# Run your first GPU workload

Install GPULink, start a local control plane and worker, run one GPU-status
diagnostic, inspect the durable result and stop both services. No repository
checkout, CUDA toolkit, model weights, cloud account or Python workload environment is
needed for this built-in diagnostic. It uses `nvidia-smi`, not a CUDA kernel.
For custom CUDA computation, see the [vector-search application](../examples/vector-search/README.md).

## 1. Check prerequisites

Use Linux or WSL with Node.js 24+, npm, Python 3 (for the result checks below),
Bash, and a working NVIDIA driver. The managed local lifecycle is not supported
on native Windows. Use a new Bash terminal with no inherited `GPULINK_*`,
`NODE_OPTIONS` or `NODE_PATH` variables; do not reuse an existing installation.
Port 8088 must be free. If another service owns it, stop here rather than
stopping or reconfiguring that service.

```bash
node --version
nvidia-smi -L
```

Use a user-owned npm installation; see [alternative prefixes](CLI_PREVIEW_RELEASE.md#install-from-npm)
if your default prefix is not writable. Never elevate privileges for npm.

## 2. Install and initialize

Run each block in the same terminal. Stop at the first error. The commands assume
`gpulink` is on PATH. The instance lives in a new private directory outside any project; its credentials and
SQLite data stay there. Do not share its `.env` files.

```bash
npm install -g @gpulink/cli@0.1.0
gpulink --version
```

Expected version: `0.1.0`. Before continuing, make sure no other process is
listening on port 8088. `local start` also refuses an occupied port.

```bash
WORK=$(mktemp -d /tmp/gpulink-first.XXXXXXXX)
SETUP="$WORK/instance"
gpulink --config-dir "$SETUP" init local
gpulink --config-dir "$SETUP" doctor control-plane
gpulink --config-dir "$SETUP" doctor worker
gpulink --config-dir "$SETUP" local start
gpulink --config-dir "$SETUP" jobs
```

Expect a passing configuration preflight and `jobs: []`. If the queue is not
empty, do not start the worker. Offline doctor checks configuration only.

## 3. Register a GPU and submit one job

The next command explicitly authorizes the worker to execute assignments.
Start it only on a host you administer, with the fresh instance from step 2.

```bash
gpulink --config-dir "$SETUP" local worker start --accept-assigned-work
gpulink --config-dir "$SETUP" local status
gpulink --config-dir "$SETUP" workers
```

Expect both managed services to report `ready-managed-local` and one online
worker with at least one GPU and the `diagnostic.gpu-status` capability. Do not
submit if that is not the case. Submit once, save the returned ID, and wait:

```bash
gpulink --config-dir "$SETUP" submit-diagnostic 256 > "$WORK/submit.json"
JOB_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["job"]["id"])' "$WORK/submit.json")
printf 'Job ID: %s\n' "$JOB_ID"
gpulink --config-dir "$SETUP" wait "$JOB_ID" > "$WORK/result.json"
```

The `256` argument is the minimum eligible VRAM in MiB. The CLI wait observes
job state; if it times out, use the same job ID with `gpulink --config-dir "$SETUP" job "$JOB_ID"`
or repeat the wait command and do not submit again merely because observation timed out.

## 4. Verify the result

```bash
python3 - "$WORK/result.json" "$JOB_ID" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    job = json.load(f)['job']
assert job['id'] == sys.argv[2]
assert job['type'] == 'diagnostic.gpu-status'
assert job['status'] == 'succeeded'
assert job['assignedGpuUuid'] == job['result']['gpu']['uuid']
print('PASS: scheduled diagnostic succeeded on its assigned GPU')
print('GPU:', job['result']['gpu']['name'])
PY
```

The GPU name and job ID will vary. A successful result confirms scheduling,
worker execution and GPU-status reporting, not ML inference or throughput.
To inspect the job and worker in the browser, run:

```bash
gpulink --config-dir "$SETUP" manager --no-open
```

Open the printed loopback URL. Manager is read-only by default and should not
be exposed to the network. The [two-host Manager acceptance](acceptance/installed-manager-two-host-2026-11-26.md)
records actual GPU telemetry, successful CUDA jobs and drain/resume evidence.

## 5. Stop and retain your result

Close Manager with Ctrl+C, confirm no work is active, then stop the worker
before the control plane. If any command fails, inspect the owned installation
rather than deleting records or killing a process by PID.

```bash
gpulink --config-dir "$SETUP" local worker stop
gpulink --config-dir "$SETUP" local stop
gpulink --config-dir "$SETUP" local status
```

The result file and database remain under `$WORK`. Keep the directory private.
Uninstalling the CLI does not delete instance data; see [uninstallation](CLI_PREVIEW_RELEASE.md#remove-the-cli).

## Next steps

- [Run a worker on another machine](MANAGED_LAN_PREVIEW.md).
- [Integrate an application or author an adapter](GETTING_STARTED.md).
- [Run a custom CUDA workload](DEVELOPER_BATCH_QUICKSTART.md).

For maintainers, the [opt-in installed GPU diagnostic gate](INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md)
with `--registry` checks the same lifecycle, exact public package integrity,
empty queue, physical GPU assignment, persisted result after restart and verified
cleanup. It is not part of ordinary CI. The November 27 registry-mode physical gate passed on an NVIDIA GeForce
RTX 3090 Ti. See the [public preview acceptance record](acceptance/public-preview-2026-11-27.md)
for the verified execution and restart-persistence results.
