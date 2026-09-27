#!/usr/bin/env bash
set -Eeuo pipefail

K3S_VERSION="${K3S_VERSION:-v1.36.4+k3s1}"
NODE_NAME="${NODE_NAME:-$(hostname)}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run this script as root"
fi

command -v curl >/dev/null 2>&1 ||
  fail "curl is required"

if command -v k3s >/dev/null 2>&1; then
  CURRENT_VERSION="$(
    k3s --version |
      awk 'NR == 1 {print $3}'
  )"

  if [[ "${CURRENT_VERSION}" == "${K3S_VERSION}" ]]; then
    echo "K3s ${K3S_VERSION} is already installed."
  else
    fail "K3s ${CURRENT_VERSION} is already installed; expected ${K3S_VERSION}. Refusing implicit upgrade/downgrade."
  fi
fi

install -d -m 0755 /etc/rancher/k3s

DESIRED_CONFIG="$(
  cat <<CONFIG_EOF
write-kubeconfig-mode: "0600"
secrets-encryption: true
node-name: "${NODE_NAME}"
node-label:
  - "gpulink.io/role=control-plane"
CONFIG_EOF
)"

CONFIG_PATH="/etc/rancher/k3s/config.yaml"

if [[ -e "${CONFIG_PATH}" ]]; then
  if ! diff -u     <(printf '%s\n' "${DESIRED_CONFIG}")     "${CONFIG_PATH}"; then
    fail "${CONFIG_PATH} already exists with different settings; refusing to overwrite it"
  fi

  echo "Existing K3s configuration verified."
else
  printf '%s\n' "${DESIRED_CONFIG}" > "${CONFIG_PATH}"
  chmod 0600 "${CONFIG_PATH}"
  echo "Created ${CONFIG_PATH}."
fi

if ! command -v k3s >/dev/null 2>&1; then
  INSTALLER="/tmp/install-k3s.sh"

  echo "Downloading official K3s installer..."
  curl -fsSL https://get.k3s.io -o "${INSTALLER}"

  chmod 0755 "${INSTALLER}"

  echo "Installing K3s ${K3S_VERSION}..."
  INSTALL_K3S_VERSION="${K3S_VERSION}" \
    "${INSTALLER}"

  rm -f "${INSTALLER}"
fi

echo "Waiting for K3s service..."
systemctl enable k3s >/dev/null

for attempt in $(seq 1 60); do
  if systemctl is-active --quiet k3s; then
    break
  fi

  if [[ "${attempt}" -eq 60 ]]; then
    systemctl --no-pager --full status k3s || true
    fail "K3s service did not become active"
  fi

  sleep 2
done

echo "Waiting for Kubernetes node to become Ready..."
if ! k3s kubectl wait   --for=condition=Ready   "node/${NODE_NAME}"   --timeout=120s; then
  journalctl -u k3s --no-pager -n 100 || true
  k3s kubectl get nodes -o wide || true
  fail "Kubernetes node did not become Ready"
fi

echo
echo "K3s runtime ready:"
echo "  Version: ${K3S_VERSION}"
echo "  Node:    ${NODE_NAME}"
echo

k3s kubectl get nodes -o wide
