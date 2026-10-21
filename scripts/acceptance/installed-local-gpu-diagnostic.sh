#!/usr/bin/env bash
# Explicit opt-in, real physical GPU status diagnostic through an independently installed GPULink CLI.
# Linux developer acceptance only. Does not deploy, publish, submit benchmarks, or create adapter sessions.
set -Eeuo pipefail
umask 077

CONSENT=YES_ALLOW_ONE_BOUNDED_GPU_DIAGNOSTIC
if [[ "${GPULINK_E2E_DIAGNOSTIC_ACK:-}" != "$CONSENT" ]]; then
  echo "REFUSED: Real worker startup and one scheduled GPU diagnostic require GPULINK_E2E_DIAGNOSTIC_ACK=$CONSENT" >&2
  exit 2
fi

[[ "$(uname -s)" == Linux ]] || { echo 'REFUSED: Linux/WSL-only managed service lifecycle.' >&2; exit 1; }
for bin in git node npm python3 nvidia-smi timeout; do
  command -v "$bin" >/dev/null 2>&1 || { echo "REFUSED: Missing dependency: $bin" >&2; exit 1; }
done
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]] || {
  echo 'REFUSED: Node.js 24+ required.' >&2; exit 1;
}

# Resolve the repository by the checked-in location of this script; no machine-specific path.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$REPO_ROOT"
[[ -f package.json && -f scripts/build-cli-package.mjs && -f src/cli/main.mjs ]] || {
  echo 'REFUSED: Not a GPULink source checkout.' >&2; exit 1;
}
BASE_SHA="$(git rev-parse HEAD)"
ORIGINAL_WORKTREE="$(git status --porcelain --untracked-files=all)"

# Never allow inherited role credentials or URLs to mix with the disposable installation.
for variable in \
  GPULINK_CONTROL_HOST GPULINK_CONTROL_PORT GPULINK_CONTROL_DATABASE GPULINK_CONTROL_DATA_PATH \
  GPULINK_CLIENT_TOKEN GPULINK_WORKER_TOKEN GPULINK_ADMIN_TOKEN \
  GPULINK_DATA_PLANE_SIGNING_KEY GPULINK_CONTROL_PLANE_URL GPULINK_URL GPULINK_WORKER_NAME; do
  if [[ -v "$variable" ]]; then
    echo "REFUSED: Inherited local profile variable $variable is set; unset it." >&2
    exit 1
  fi
done

# A conservative, read-only preflight: don't contact or attempt to stop an unrelated listener.
python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('127.0.0.1', 8088))
        s.listen(1)
    except OSError:
        raise SystemExit('REFUSED: loopback port 8088 cannot be reserved; no process was stopped')
PY
nvidia-smi -L >/dev/null || { echo 'REFUSED: No accessible NVIDIA GPU inventory.' >&2; exit 1; }

# The installation, package and all JSON records stay out of the source tree.
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gpulink-installed-acceptance-XXXXXXXX")"
INSTANCE="$TMP_ROOT/instance"
CONSUMER="$TMP_ROOT/consumer"
ARTIFACTS="$TMP_ROOT/artifacts"
CLI="$CONSUMER/node_modules/.bin/gpulink"
PASSED=0

# Check the kernel's listening sockets, not bind(), during cleanup: TCP TIME_WAIT
# must not lead to false claims of a leaked GPULink control plane.
no_listeners_on_8088() {
  python3 - <<'PY'
from pathlib import Path
port = '1F98'  # 8088
for name in ('/proc/net/tcp', '/proc/net/tcp6'):
    content = Path(name).read_text(encoding='ascii').splitlines()[1:]
    for row in content:
        parts = row.split()
        if len(parts) > 3 and parts[1].rsplit(':', 1)[-1].upper() == port and parts[3] == '0A':
            raise SystemExit(1)
PY
}

cleanup() {
  local prior_rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ -x "$CLI" && -d "$INSTANCE" ]]; then
    if [[ -e "$INSTANCE/run/worker.owner.json" || -L "$INSTANCE/run/worker.owner.json" ||
          -e "$INSTANCE/run/worker.sock" || -L "$INSTANCE/run/worker.sock" ]]; then
      echo 'CLEANUP: Requesting installation-verified worker shutdown.'
      "$CLI" --config-dir "$INSTANCE" local worker stop >/dev/null 2>&1 ||
        echo 'WARNING: Worker shutdown unverified; ownership state will be preserved.' >&2
    fi
    if [[ -e "$INSTANCE/run/control-plane.owner.json" || -L "$INSTANCE/run/control-plane.owner.json" ||
          -e "$INSTANCE/run/control-plane.sock" || -L "$INSTANCE/run/control-plane.sock" ]]; then
      echo 'CLEANUP: Requesting installation-verified control-plane shutdown.'
      "$CLI" --config-dir "$INSTANCE" local stop >/dev/null 2>&1 ||
        echo 'WARNING: Control-plane shutdown unverified; ownership state will be preserved.' >&2
    fi
  fi

  local unresolved=0 artifact
  for artifact in \
    worker.owner.json worker.sock control-plane.owner.json control-plane.sock start.lock; do
    if [[ -e "$INSTANCE/run/$artifact" || -L "$INSTANCE/run/$artifact" ]]; then
      echo "WARNING: Unresolved lifecycle artifact: $artifact" >&2
      unresolved=1
    fi
  done
  no_listeners_on_8088 || { echo 'WARNING: TCP listener on 8088 or unverifiable listener state.' >&2; unresolved=1; }

  if [[ "$PASSED" == 1 && "$prior_rc" == 0 && "$unresolved" == 0 &&
        -d "$TMP_ROOT" && ! -L "$TMP_ROOT" &&
        "$(stat -c '%u' "$TMP_ROOT")" == "$(id -u)" ]]; then
    rm -rf -- "$TMP_ROOT"
    echo 'PASS: All checks passed; confirmed stopped; disposable installation removed.'
    exit 0
  fi
  echo "INCOMPLETE: Temporary installation preserved for investigation: $TMP_ROOT" >&2
  echo 'Never kill a PID or remove a process-ownership record without verifying its identity.' >&2
  if [[ "$prior_rc" != 0 ]]; then exit "$prior_rc"; fi
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' '===== GPULINK — REPRODUCIBLE INSTALLED GPU DIAGNOSTIC ====='
echo '===== Build and install private CLI outside source checkout ====='
VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.-]+)?$ ]] || {
  echo 'STOP: Unsupported package version.' >&2; exit 1;
}
npm run build:cli -- "$ARTIFACTS"
TARBALL="$ARTIFACTS/gpulink-cli-$VERSION.tgz"
[[ -f "$TARBALL" ]] || { echo 'STOP: Built private CLI tarball missing.' >&2; exit 1; }
mkdir -p "$CONSUMER"
npm install --prefix "$CONSUMER" --no-audit --no-fund "$TARBALL"
[[ -x "$CLI" && "$("$CLI" --version)" == "$VERSION" ]] || {
  echo 'STOP: Installed CLI executable/version invalid.' >&2; exit 1;
}

echo '===== Fresh local setup and zero jobs ====='
"$CLI" --config-dir "$INSTANCE" init local
"$CLI" --config-dir "$INSTANCE" local start
"$CLI" --config-dir "$INSTANCE" jobs > "$TMP_ROOT/jobs-before.json"
python3 - "$TMP_ROOT/jobs-before.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f: jobs = json.load(f).get('jobs')
assert isinstance(jobs, list) and len(jobs) == 0, 'Fresh installation must contain no jobs'
print('PASS: Fresh isolated job queue is empty.')
PY

echo '===== Explicitly authorized local worker registration ====='
"$CLI" --config-dir "$INSTANCE" local worker start --accept-assigned-work
"$CLI" --config-dir "$INSTANCE" local status > "$TMP_ROOT/status.json"
"$CLI" --config-dir "$INSTANCE" workers > "$TMP_ROOT/workers.json"
python3 - "$TMP_ROOT/status.json" "$TMP_ROOT/workers.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f: state = json.load(f)
with open(sys.argv[2], encoding='utf-8') as f: workers = json.load(f).get('workers')
assert state.get('controlPlane') == 'ready-managed-local', 'Control plane not installation-owned ready'
assert state.get('localWorker') == 'ready-managed-local', 'Worker not installation-owned ready'
assert isinstance(workers, list) and len(workers) == 1, 'Expected exactly one registered worker'
w = workers[0]
assert w.get('status') == 'online', 'Worker not online'
assert isinstance(w.get('gpus'), list) and len(w['gpus']) >= 1, 'No GPUs reported'
assert 'diagnostic.gpu-status' in w.get('capabilities', []), 'GPU status diagnostic not supported'
print(f"PASS: One online worker, {len(w['gpus'])} GPU(s) reported; diagnostic capability ready.")
PY

echo '===== Submit one bounded diagnostic and verify authoritative success ====='
"$CLI" --config-dir "$INSTANCE" submit-diagnostic 256 > "$TMP_ROOT/submit.json"
JOB_ID="$(python3 - "$TMP_ROOT/submit.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f: job = json.load(f).get('job', {})
assert job.get('type') == 'diagnostic.gpu-status', 'Wrong submitted workload'
assert isinstance(job.get('id'), str) and job['id'].startswith('job_'), 'Missing job ID'
print(job['id'])
PY
)"
printf 'Submitted diagnostic job: %s\n' "$JOB_ID"
"$CLI" --config-dir "$INSTANCE" jobs > "$TMP_ROOT/jobs-after.json"
python3 - "$TMP_ROOT/jobs-after.json" "$JOB_ID" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: jobs = json.load(f).get('jobs', [])
assert len(jobs) == 1 and jobs[0].get('id') == sys.argv[2], 'Expected only the authorized job'
PY
timeout 110s "$CLI" --config-dir "$INSTANCE" wait "$JOB_ID" > "$TMP_ROOT/completed.json"
python3 - "$TMP_ROOT/completed.json" "$JOB_ID" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: job = json.load(f).get('job', {})
assert job.get('id') == sys.argv[2], 'Unexpected job ID'
assert job.get('type') == 'diagnostic.gpu-status', 'Unexpected workload'
assert job.get('status') == 'succeeded', 'Job failed or did not complete'
result = job.get('result')
assert isinstance(result, dict) and isinstance(result.get('gpu'), dict), 'No GPU result'
assert job.get('assignedGpuUuid') == result['gpu'].get('uuid'), 'Reported GPU does not match assignment'
print('PASS: Scheduler, worker and authoritative result agree.')
print('GPU:', str(result['gpu'].get('name'))[:96])
PY

echo '===== Shutdown in dependency order and verify durable SQLite result ====='
"$CLI" --config-dir "$INSTANCE" local worker stop
"$CLI" --config-dir "$INSTANCE" local stop
[[ -s "$INSTANCE/control-plane.sqlite" ]] || { echo 'STOP: SQLite missing.' >&2; exit 1; }
"$CLI" --config-dir "$INSTANCE" local start
"$CLI" --config-dir "$INSTANCE" job "$JOB_ID" > "$TMP_ROOT/persisted.json"
python3 - "$TMP_ROOT/persisted.json" "$JOB_ID" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: job = json.load(f).get('job', {})
assert job.get('id') == sys.argv[2] and job.get('status') == 'succeeded', 'Completed job not durable'
assert job.get('type') == 'diagnostic.gpu-status', 'Persisted job type changed'
print('PASS: Durable completed job retrieved after restart.')
PY
"$CLI" --config-dir "$INSTANCE" local stop
[[ -s "$INSTANCE/control-plane.sqlite" ]] || { echo 'STOP: SQLite disappeared.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$BASE_SHA" ]] || { echo 'STOP: Repository HEAD changed.' >&2; exit 1; }
[[ "$(git status --porcelain --untracked-files=all)" == "$ORIGINAL_WORKTREE" ]] || {
  echo 'STOP: Repository worktree changed during acceptance.' >&2; exit 1;
}
PASSED=1
echo 'PASS: Installed CLI -> managed control plane -> registered GPU -> one scheduled diagnostic -> persisted completion.'
echo 'No benchmarks, adapter sessions, npm publication, AWS operations or repository writes.'
