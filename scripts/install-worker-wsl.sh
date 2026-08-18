#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo while preserving the required environment variables." >&2
  exit 1
fi
if [[ $# -ne 1 || -z ${1} ]]; then
  echo "Usage: sudo -E ./scripts/install-worker-wsl.sh <worker-name>" >&2
  exit 1
fi
worker_name="${1}"
if [[ ! ${worker_name} =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$ ]]; then
  echo "Worker name may contain only letters, numbers, periods, underscores, and hyphens." >&2
  exit 1
fi
: "${GPULINK_URL:?Set GPULINK_URL to the public HTTPS GPUlink URL.}"
: "${GPULINK_WORKER_TOKEN:?Set GPULINK_WORKER_TOKEN without placing it in shell history.}"
if [[ ! ${GPULINK_URL} =~ ^https:// ]]; then
  echo "GPULINK_URL must use HTTPS for a remote worker." >&2
  exit 1
fi
if [[ ${#GPULINK_WORKER_TOKEN} -lt 32 ]]; then
  echo "GPULINK_WORKER_TOKEN must contain at least 32 characters." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_binary="${GPULINK_NODE_BINARY:-}"
if [[ -z ${node_binary} || ${node_binary} != /* || ! -x ${node_binary} ]]; then
  echo "Set GPULINK_NODE_BINARY to an absolute, executable Node.js 24 path before sudo." >&2
  exit 1
fi
node_binary="$(readlink -f "${node_binary}")"
node_major="$("${node_binary}" --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z ${node_major} || ${node_major} -lt 24 ]]; then
  echo "GPULINK_NODE_BINARY must identify Node.js 24 or newer." >&2
  exit 1
fi
if ! systemctl show --property=Version >/dev/null 2>&1; then
  echo "WSL systemd is not running. Enable systemd in /etc/wsl.conf and restart WSL." >&2
  exit 1
fi
nvidia_smi_binary="${GPULINK_NVIDIA_SMI_BINARY:-/usr/lib/wsl/lib/nvidia-smi}"
if [[ ${nvidia_smi_binary} != /* || ! -x ${nvidia_smi_binary} ]] \
  || ! "${nvidia_smi_binary}" >/dev/null 2>&1; then
  echo "nvidia-smi is not available inside WSL. Fix NVIDIA WSL GPU access first." >&2
  exit 1
fi

id -u gpulink >/dev/null 2>&1 || useradd --system --home /var/lib/gpulink --create-home --shell /usr/sbin/nologin gpulink
getent group video >/dev/null 2>&1 && usermod -aG video gpulink
getent group render >/dev/null 2>&1 && usermod -aG render gpulink
install -d -o root -g root -m 0755 /opt/gpulink
install -d -o root -g root -m 0755 /opt/gpulink/runtime
install -d -o gpulink -g gpulink -m 0750 /var/lib/gpulink/cache
install -d -o root -g gpulink -m 0750 /etc/gpulink

cp -a "${repository_root}/package.json" "${repository_root}/src" /opt/gpulink/
chown -R root:root /opt/gpulink
find /opt/gpulink -type d -exec chmod 0755 {} +
find /opt/gpulink -type f -exec chmod 0644 {} +
install -o root -g root -m 0755 "${node_binary}" /opt/gpulink/runtime/node
/opt/gpulink/runtime/node --version

host_type="${GPULINK_WORKER_HOST_TYPE:-desktop}"
worker_capabilities="diagnostic.echo,diagnostic.gpu-status"
benchmark_python=/opt/gpulink/runtime/benchmark/bin/python
benchmark_runner=/opt/gpulink/src/worker/runners/gpu-benchmark.py
if [[ -x ${benchmark_python} && -r ${benchmark_runner} ]]; then
  gpu_uuid="$("${nvidia_smi_binary}" --query-gpu=uuid --format=csv,noheader | sed -n '1{s/[[:space:]]*$//;p;}')"
  if [[ -n ${gpu_uuid} ]] && runuser -u gpulink -- env -i \
    HOME=/var/lib/gpulink \
    XDG_CACHE_HOME=/var/lib/gpulink/cache \
    PATH=/opt/gpulink/runtime:/usr/lib/wsl/lib:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin \
    LD_LIBRARY_PATH=/usr/lib/wsl/lib \
    CUDA_VISIBLE_DEVICES="${gpu_uuid}" \
    PYTHONUNBUFFERED=1 \
    "${benchmark_python}" "${benchmark_runner}" --health >/dev/null 2>&1; then
    worker_capabilities+=",benchmark.gpu"
  fi
fi
environment_file=/etc/gpulink/worker.env
umask 0077
{
  echo "GPULINK_CONTROL_PLANE_URL=${GPULINK_URL%/}"
  echo "GPULINK_WORKER_TOKEN=${GPULINK_WORKER_TOKEN}"
  echo "GPULINK_WORKER_NAME=${worker_name}"
  echo "GPULINK_WORKER_HEARTBEAT_INTERVAL_MS=5000"
  echo "GPULINK_WORKER_ASSIGNMENT_INTERVAL_MS=1000"
  echo "GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS=300000"
  echo "GPULINK_WORKER_CAPABILITIES=${worker_capabilities}"
  echo "GPULINK_BENCHMARK_PYTHON=${benchmark_python}"
  echo "GPULINK_BENCHMARK_TIMEOUT_MS=60000"
  printf 'GPULINK_WORKER_LABELS_JSON={"hostType":"%s","operatingSystem":"windows-wsl","availabilityProfile":"shared"}\n' "${host_type}"
  echo "GPULINK_WORKER_WARM_MODELS_JSON=[]"
} > "${environment_file}"
chown root:gpulink "${environment_file}"
chmod 0640 "${environment_file}"

install -o root -g root -m 0644 \
  "${repository_root}/deploy/wsl/gpulink-worker.service" \
  /etc/systemd/system/gpulink-worker.service
systemctl daemon-reload
systemctl enable --now gpulink-worker.service
systemctl --no-pager --full status gpulink-worker.service
