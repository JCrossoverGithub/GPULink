#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "STOP: $*" >&2
  exit 1
}

service_has_legacy_signature() {
  local path="${1}"

  [[ -f ${path} ]] || return 1

  local required_line

  for required_line in \
    'Description=GPUlink WSL GPU worker' \
    'User=gpulink' \
    'Group=gpulink' \
    'WorkingDirectory=/opt/gpulink' \
    'EnvironmentFile=/etc/gpulink/worker.env' \
    'ExecStart=/opt/gpulink/runtime/node /opt/gpulink/src/worker/main.mjs'
  do
    grep -Fxq -- "${required_line}" "${path}" || return 1
  done
}

environment_has_legacy_signature() {
  local path="${1}"

  [[ -f ${path} ]] || return 1

  grep -Eq '^GPULINK_CONTROL_PLANE_URL=https://.+' "${path}" \
    && grep -Eq '^GPULINK_WORKER_TOKEN=.{32,}$' "${path}" \
    && grep -Eq '^GPULINK_WORKER_NAME=[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$' "${path}" \
    && grep -Eq '^GPULINK_WORKER_CAPABILITIES=.+' "${path}"
}

show_service_failure_context() {
  systemctl --no-pager --full status gpulink-worker.service || true
  journalctl \
    -u gpulink-worker.service \
    -n 40 \
    --no-pager || true
}

if [[ ${EUID} -ne 0 ]]; then
  die "Run this installer with sudo while preserving the required environment variables."
fi

if [[ $# -ne 1 || -z ${1} ]]; then
  echo "Usage: sudo -E ./scripts/install-worker-wsl.sh <worker-name>" >&2
  exit 1
fi

worker_name="${1}"

if [[ ! ${worker_name} =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$ ]]; then
  die "Worker name may contain only letters, numbers, periods, underscores, and hyphens."
fi

: "${GPULINK_URL:?Set GPULINK_URL to the public HTTPS GPUlink URL.}"
: "${GPULINK_WORKER_TOKEN:?Set GPULINK_WORKER_TOKEN without placing it in shell history.}"

if [[ ! ${GPULINK_URL} =~ ^https:// ]]; then
  die "GPULINK_URL must use HTTPS for a remote worker."
fi

if [[ ${#GPULINK_WORKER_TOKEN} -lt 32 ]]; then
  die "GPULINK_WORKER_TOKEN must contain at least 32 characters."
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

service_source="${repository_root}/deploy/wsl/gpulink-worker.service"
service_file=/etc/systemd/system/gpulink-worker.service
environment_dir=/etc/gpulink
environment_file="${environment_dir}/worker.env"
install_state_file="${environment_dir}/install-state"
install_root=/opt/gpulink

[[ -r ${service_source} ]] || {
  die "Worker service template is missing: ${service_source}"
}

node_binary="${GPULINK_NODE_BINARY:-}"

if [[ -z ${node_binary} || ${node_binary} != /* || ! -x ${node_binary} ]]; then
  die "Set GPULINK_NODE_BINARY to an absolute, executable Node.js 24 path before sudo."
fi

node_binary="$(readlink -f "${node_binary}")"

node_major="$(
  "${node_binary}" --version 2>/dev/null |
    sed -E 's/^v([0-9]+).*/\1/' ||
    true
)"

if [[ -z ${node_major} || ${node_major} -lt 24 ]]; then
  die "GPULINK_NODE_BINARY must identify Node.js 24 or newer."
fi

if ! systemctl show --property=Version >/dev/null 2>&1; then
  die "WSL systemd is not running. Enable systemd in /etc/wsl.conf and restart WSL."
fi

nvidia_smi_binary="${GPULINK_NVIDIA_SMI_BINARY:-/usr/lib/wsl/lib/nvidia-smi}"

if [[ ${nvidia_smi_binary} != /* || ! -x ${nvidia_smi_binary} ]] \
  || ! "${nvidia_smi_binary}" >/dev/null 2>&1; then
  die "nvidia-smi is not available inside WSL. Fix NVIDIA WSL GPU access first."
fi

echo
echo "===== GPULINK INSTALL STATE ====="

managed_install=false
legacy_install=false
system_artifacts=false

for path in \
  "${service_file}" \
  "${environment_dir}" \
  "${install_root}"
do
  if [[ -e ${path} ]]; then
    system_artifacts=true
  fi
done

if [[ -f ${install_state_file} ]]; then
  if grep -Fxq 'managed_by=gpulink' "${install_state_file}" \
    && grep -Fxq 'component=worker' "${install_state_file}"; then
    managed_install=true
  else
    die "Existing ${install_state_file} is not a recognized GPULink worker installation marker. Refusing to overwrite it."
  fi
fi

#
# Backward compatibility for workers installed before install-state
# markers existed.
#
# Do not require the old unit to be byte-for-byte identical to the
# current template: legitimate GPULink releases may add or change
# systemd hardening directives over time. Instead, require stable
# ownership and execution fields that identify the unit as the
# GPULink worker.
#
# A recognizable worker.env is also sufficient legacy evidence when
# the unit itself is missing, which lets the installer repair a
# partially removed legacy installation.
#
if [[ ${managed_install} == false ]]; then
  legacy_service_signature=false
  legacy_environment_signature=false

  if [[ -f ${service_file} ]]; then
    if service_has_legacy_signature "${service_file}"; then
      legacy_service_signature=true
    else
      die "A gpulink-worker.service exists but does not have the recognized GPULink worker signature. Refusing to overwrite it."
    fi
  fi

  if environment_has_legacy_signature "${environment_file}"; then
    legacy_environment_signature=true
  fi

  if [[ ${legacy_service_signature} == true \
     || ${legacy_environment_signature} == true ]]; then
    legacy_install=true
    echo "INSTALL STATE: recognized legacy GPULink worker installation"

    if [[ ${legacy_service_signature} == true ]]; then
      echo "LEGACY EVIDENCE: GPULink systemd unit signature"
    fi

    if [[ ${legacy_environment_signature} == true ]]; then
      echo "LEGACY EVIDENCE: GPULink worker environment signature"
    fi
  fi
fi

if [[ ${managed_install} == false \
   && ${legacy_install} == false \
   && ${system_artifacts} == true ]]; then
  die "GPULink installation paths already contain unrecognized state. Refusing to overwrite them automatically."
fi

if [[ ${managed_install} == false \
   && ${legacy_install} == false \
   && ${system_artifacts} == false ]]; then
  echo "INSTALL STATE: clean host"
else
  missing=()

  [[ -f ${service_file} ]] || missing+=("${service_file}")
  [[ -f ${environment_file} ]] || missing+=("${environment_file}")
  [[ -x ${install_root}/runtime/node ]] || missing+=("${install_root}/runtime/node")
  [[ -r ${install_root}/src/worker/main.mjs ]] || missing+=("${install_root}/src/worker/main.mjs")

  if (( ${#missing[@]} == 0 )); then
    echo "INSTALL STATE: complete GPULink worker installation detected"
    echo "ACTION: reconciling existing GPULink-managed installation"
  else
    echo "INSTALL STATE: partial GPULink worker installation detected"
    echo "ACTION: repairing GPULink-managed installation"
    printf 'MISSING: %s\n' "${missing[@]}"
  fi

  #
  # Avoid a restart loop while files are being reconciled.
  #
  if systemctl cat gpulink-worker.service >/dev/null 2>&1; then
    systemctl stop gpulink-worker.service || true
  fi
fi

#
# An existing worker identity is not silently renamed. Renaming a
# durable worker should be an explicit operator decision.
#
if [[ -f ${environment_file} ]]; then
  existing_worker_name="$(
    sed -n 's/^GPULINK_WORKER_NAME=//p' "${environment_file}" |
      tail -n 1
  )"

  if [[ -n ${existing_worker_name} \
     && ${existing_worker_name} != "${worker_name}" ]]; then
    die "Existing worker is named '${existing_worker_name}', but '${worker_name}' was requested. Refusing an implicit worker rename."
  fi
fi

echo
echo "===== INSTALLING GPULINK WORKER ====="

id -u gpulink >/dev/null 2>&1 \
  || useradd \
    --system \
    --home /var/lib/gpulink \
    --create-home \
    --shell /usr/sbin/nologin \
    gpulink

getent group video >/dev/null 2>&1 \
  && usermod -aG video gpulink

getent group render >/dev/null 2>&1 \
  && usermod -aG render gpulink

install -d -o root -g root -m 0755 "${install_root}"
install -d -o root -g root -m 0755 "${install_root}/runtime"

install -d \
  -o gpulink \
  -g gpulink \
  -m 0750 \
  /var/lib/gpulink/cache

install -d \
  -o gpulink \
  -g gpulink \
  -m 0750 \
  /var/lib/gpulink/models

install -d \
  -o root \
  -g gpulink \
  -m 0750 \
  "${environment_dir}"

#
# Replace application source rather than merging into a potentially
# stale source tree. Runtime assets such as the benchmark virtualenv
# remain untouched.
#
rm -rf "${install_root}/src"
rm -f "${install_root}/package.json"

cp -a \
  "${repository_root}/package.json" \
  "${repository_root}/src" \
  "${install_root}/"

chown -R root:root \
  "${install_root}/package.json" \
  "${install_root}/src"

find "${install_root}/src" -type d -exec chmod 0755 {} +
find "${install_root}/src" -type f -exec chmod 0644 {} +
chmod 0644 "${install_root}/package.json"

install \
  -o root \
  -g root \
  -m 0755 \
  "${node_binary}" \
  "${install_root}/runtime/node"

"${install_root}/runtime/node" --version

host_type="${GPULINK_WORKER_HOST_TYPE:-desktop}"

worker_capabilities="diagnostic.echo,diagnostic.gpu-status"
benchmark_python="${install_root}/runtime/benchmark/bin/python"
benchmark_runner="${install_root}/src/worker/runners/gpu-benchmark.py"

if [[ -x ${benchmark_python} && -r ${benchmark_runner} ]]; then
  gpu_uuid="$(
    "${nvidia_smi_binary}" \
      --query-gpu=uuid \
      --format=csv,noheader |
      sed -n '1{s/[[:space:]]*$//;p;}'
  )"

  if [[ -n ${gpu_uuid} ]] \
    && runuser -u gpulink -- env -i \
      HOME=/var/lib/gpulink \
      XDG_CACHE_HOME=/var/lib/gpulink/cache \
      PATH=/opt/gpulink/runtime:/usr/lib/wsl/lib:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin \
      LD_LIBRARY_PATH=/usr/lib/wsl/lib \
      CUDA_VISIBLE_DEVICES="${gpu_uuid}" \
      PYTHONUNBUFFERED=1 \
      "${benchmark_python}" \
      "${benchmark_runner}" \
      --health >/dev/null 2>&1; then
    worker_capabilities+=",benchmark.gpu"
  fi
fi

echo
echo "===== WRITING WORKER CONFIGURATION ====="

umask 0077

environment_tmp="$(
  mktemp "${environment_dir}/.worker.env.XXXXXX"
)"

state_tmp="$(
  mktemp "${environment_dir}/.install-state.XXXXXX"
)"

cleanup_tmp() {
  rm -f \
    "${environment_tmp:-}" \
    "${state_tmp:-}"
}

trap cleanup_tmp EXIT

{
  echo "GPULINK_CONTROL_PLANE_URL=${GPULINK_URL%/}"
  echo "GPULINK_WORKER_TOKEN=${GPULINK_WORKER_TOKEN}"
  echo "GPULINK_WORKER_NAME=${worker_name}"
  echo "GPULINK_WORKER_HEARTBEAT_INTERVAL_MS=5000"
  echo "GPULINK_WORKER_ASSIGNMENT_INTERVAL_MS=1000"
  echo "GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS=300000"
  echo "GPULINK_WORKER_MODEL_INVENTORY_INTERVAL_MS=300000"
  echo "GPULINK_WORKER_CAPABILITIES=${worker_capabilities}"
  echo "GPULINK_MODEL_CACHE_ROOT=/var/lib/gpulink/models"
  echo "GPULINK_MODEL_CACHE_MANIFEST=/var/lib/gpulink/models/manifest.json"
  echo "GPULINK_BENCHMARK_PYTHON=${benchmark_python}"
  echo "GPULINK_BENCHMARK_TIMEOUT_MS=60000"

  printf \
    'GPULINK_WORKER_LABELS_JSON={"hostType":"%s","operatingSystem":"windows-wsl","availabilityProfile":"shared"}\n' \
    "${host_type}"

  echo "GPULINK_WORKER_WARM_MODELS_JSON=[]"
} > "${environment_tmp}"

install \
  -o root \
  -g gpulink \
  -m 0640 \
  "${environment_tmp}" \
  "${environment_file}"

{
  echo "managed_by=gpulink"
  echo "component=worker"
  echo "installer_state_version=1"
} > "${state_tmp}"

install \
  -o root \
  -g root \
  -m 0644 \
  "${state_tmp}" \
  "${install_state_file}"

install \
  -o root \
  -g root \
  -m 0644 \
  "${service_source}" \
  "${service_file}"

systemctl daemon-reload
systemctl enable --now gpulink-worker.service

echo
echo "===== INSTALLATION VERIFICATION ====="

if ! systemctl is-enabled --quiet gpulink-worker.service; then
  die "gpulink-worker.service was not enabled."
fi

if ! systemctl is-active --quiet gpulink-worker.service; then
  show_service_failure_context
  die "gpulink-worker.service did not become active."
fi

main_pid="$(
  systemctl show \
    gpulink-worker.service \
    --property=MainPID \
    --value
)"

if [[ ! ${main_pid} =~ ^[1-9][0-9]*$ ]]; then
  show_service_failure_context
  die "gpulink-worker.service does not have a live main process."
fi

restart_count_baseline="$(
  systemctl show \
    gpulink-worker.service \
    --property=NRestarts \
    --value
)"

if [[ ! ${restart_count_baseline} =~ ^[0-9]+$ ]]; then
  show_service_failure_context
  die "gpulink-worker.service returned an invalid restart count."
fi

echo "SERVICE STABILITY: verifying the worker for 8 seconds"

for (( second = 1; second <= 8; second++ )); do
  sleep 1

  if ! systemctl is-active --quiet gpulink-worker.service; then
    show_service_failure_context
    die "gpulink-worker.service exited during the post-install stability window."
  fi

  current_pid="$(
    systemctl show \
      gpulink-worker.service \
      --property=MainPID \
      --value
  )"

  current_restart_count="$(
    systemctl show \
      gpulink-worker.service \
      --property=NRestarts \
      --value
  )"

  if [[ ! ${current_pid} =~ ^[1-9][0-9]*$ ]]; then
    show_service_failure_context
    die "gpulink-worker.service lost its main process during the post-install stability window."
  fi

  if [[ ${current_pid} != "${main_pid}" ]]; then
    show_service_failure_context
    die "gpulink-worker.service restarted during the post-install stability window."
  fi

  if [[ ! ${current_restart_count} =~ ^[0-9]+$ \
     || ${current_restart_count} -ne ${restart_count_baseline} ]]; then
    show_service_failure_context
    die "gpulink-worker.service restart count changed during the post-install stability window."
  fi
done

echo "PASS: worker remained stable with PID ${main_pid} and NRestarts=${restart_count_baseline}."

systemctl --no-pager --full status gpulink-worker.service

echo
echo "PASS: GPULink worker installation reconciled successfully."
