#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z ${node_major} || ${node_major} -lt 24 ]]; then
  echo "Node.js 24 or newer is required before installing GPUlink." >&2
  exit 1
fi
if [[ $(command -v node) != "/usr/bin/node" ]]; then
  echo "Install Node.js 24 system-wide at /usr/bin/node so the system service can start it." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate GPUlink credentials." >&2
  exit 1
fi

id -u gpulink >/dev/null 2>&1 || useradd --system --home /var/lib/gpulink --shell /usr/sbin/nologin gpulink
install -d -o gpulink -g gpulink -m 0750 /var/lib/gpulink
install -d -o root -g root -m 0755 /opt/gpulink
install -d -o root -g gpulink -m 0750 /etc/gpulink

cp -a "${repository_root}/package.json" "${repository_root}/src" /opt/gpulink/
chown -R root:root /opt/gpulink
find /opt/gpulink -type d -exec chmod 0755 {} +
find /opt/gpulink -type f -exec chmod 0644 {} +

environment_file=/etc/gpulink/control-plane.env
if [[ ! -e ${environment_file} ]]; then
  umask 0077
  client_token="$(openssl rand -hex 32)"
  worker_token="$(openssl rand -hex 32)"
  admin_token="$(openssl rand -hex 32)"
  {
    echo "GPULINK_CONTROL_HOST=127.0.0.1"
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
  chown root:gpulink "${environment_file}"
  chmod 0640 "${environment_file}"
  echo "Created new credentials in ${environment_file}."
else
  echo "Preserved existing credentials in ${environment_file}."
fi

install -o root -g root -m 0644 \
  "${repository_root}/deploy/digitalocean/gpulink-control.service" \
  /etc/systemd/system/gpulink-control.service
systemctl daemon-reload
systemctl enable --now gpulink-control.service
systemctl --no-pager --full status gpulink-control.service

echo "GPUlink is listening only on 127.0.0.1:8088."
echo "Configure a reverse proxy and HTTPS before allowing external clients."
