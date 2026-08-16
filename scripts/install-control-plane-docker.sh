#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine is required before installing GPUlink." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required before installing GPUlink." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate GPUlink credentials." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root=/opt/gpulink
environment_file=/etc/gpulink/control-plane.env
compose_file="${install_root}/deploy/digitalocean/compose.yml"

install -d -o root -g root -m 0755 "${install_root}"
install -d -o root -g root -m 0700 /etc/gpulink
install -d -o root -g root -m 0755 "${install_root}/deploy/digitalocean"

cp -a "${repository_root}/package.json" "${repository_root}/src" "${install_root}/"
cp -a \
  "${repository_root}/deploy/digitalocean/Dockerfile" \
  "${repository_root}/deploy/digitalocean/compose.yml" \
  "${install_root}/deploy/digitalocean/"
chown -R root:root "${install_root}"
find "${install_root}" -type d -exec chmod 0755 {} +
find "${install_root}" -type f -exec chmod 0644 {} +

if [[ ! -e ${environment_file} ]]; then
  umask 0077
  client_token="$(openssl rand -hex 32)"
  worker_token="$(openssl rand -hex 32)"
  admin_token="$(openssl rand -hex 32)"
  {
    echo "GPULINK_CONTROL_HOST=0.0.0.0"
    echo "GPULINK_CONTROL_PORT=8088"
    echo "GPULINK_CONTROL_DATA_PATH=/var/lib/gpulink/control-plane.sqlite"
    echo "GPULINK_CONTROL_HEARTBEAT_TIMEOUT_MS=15000"
    echo "GPULINK_CONTROL_LEASE_DURATION_MS=30000"
    echo "GPULINK_CONTROL_SCHEDULER_INTERVAL_MS=1000"
    echo "GPULINK_CONTROL_VRAM_SAFETY_MIB=512"
    echo "GPULINK_CLIENT_TOKEN=${client_token}"
    echo "GPULINK_WORKER_TOKEN=${worker_token}"
    echo "GPULINK_ADMIN_TOKEN=${admin_token}"
  } > "${environment_file}"
  chmod 0600 "${environment_file}"
  echo "Created new credentials in ${environment_file}."
else
  echo "Preserved existing credentials in ${environment_file}."
fi

docker compose -f "${compose_file}" up -d --build
docker compose -f "${compose_file}" ps

echo "GPUlink is published only on 127.0.0.1:8088."
echo "Configure and validate Nginx before allowing external clients."
