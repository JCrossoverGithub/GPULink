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
node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z ${node_major} || ${node_major} -lt 24 ]]; then
  echo "Node.js 24 or newer is required inside WSL." >&2
  exit 1
fi
if [[ $(command -v node) != "/usr/bin/node" ]]; then
  echo "Install Node.js 24 system-wide at /usr/bin/node so the system service can start it." >&2
  exit 1
fi
if ! systemctl show --property=Version >/dev/null 2>&1; then
  echo "WSL systemd is not running. Enable systemd in /etc/wsl.conf and restart WSL." >&2
  exit 1
fi
if ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is not available inside WSL. Fix NVIDIA WSL GPU access first." >&2
  exit 1
fi

id -u gpulink >/dev/null 2>&1 || useradd --system --home /var/lib/gpulink --create-home --shell /usr/sbin/nologin gpulink
getent group video >/dev/null 2>&1 && usermod -aG video gpulink
getent group render >/dev/null 2>&1 && usermod -aG render gpulink
install -d -o root -g root -m 0755 /opt/gpulink
install -d -o root -g gpulink -m 0750 /etc/gpulink

cp -a "${repository_root}/package.json" "${repository_root}/src" /opt/gpulink/
chown -R root:root /opt/gpulink
find /opt/gpulink -type d -exec chmod 0755 {} +
find /opt/gpulink -type f -exec chmod 0644 {} +

host_type="${GPULINK_WORKER_HOST_TYPE:-desktop}"
environment_file=/etc/gpulink/worker.env
umask 0077
{
  echo "GPULINK_CONTROL_PLANE_URL=${GPULINK_URL%/}"
  echo "GPULINK_WORKER_TOKEN=${GPULINK_WORKER_TOKEN}"
  echo "GPULINK_WORKER_NAME=${worker_name}"
  echo "GPULINK_WORKER_HEARTBEAT_INTERVAL_MS=5000"
  echo "GPULINK_WORKER_ASSIGNMENT_INTERVAL_MS=1000"
  echo "GPULINK_WORKER_CAPABILITIES=diagnostic.echo,diagnostic.gpu-status"
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
