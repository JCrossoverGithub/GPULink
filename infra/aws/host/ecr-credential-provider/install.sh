#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_SHA256="090e59c660d2106532a641ba58199f792e4bc076c6ebb238aabab1f1f5eff95c"

BIN_DIR="/var/lib/rancher/credentialprovider/bin"
CONFIG_DIR="/var/lib/rancher/credentialprovider"

BIN_PATH="${BIN_DIR}/ecr-credential-provider"
CONFIG_PATH="${CONFIG_DIR}/config.yaml"

SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd
)"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run as root"
fi

if [[ $# -ne 1 ]]; then
  fail "usage: $0 /path/to/ecr-credential-provider"
fi

SOURCE_BINARY="$1"

[[ -f "${SOURCE_BINARY}" ]] ||
  fail "provider binary does not exist: ${SOURCE_BINARY}"

[[ -f "${SCRIPT_DIR}/config.yaml" ]] ||
  fail "credential-provider config is missing"

command -v sha256sum >/dev/null 2>&1 ||
  fail "sha256sum is required"

ACTUAL_SHA256="$(
  sha256sum "${SOURCE_BINARY}" |
    awk '{print $1}'
)"

if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  fail "provider checksum mismatch: expected ${EXPECTED_SHA256}, got ${ACTUAL_SHA256}"
fi

echo "Provider checksum verified."

install -d \
  -o root \
  -g root \
  -m 0755 \
  "${BIN_DIR}"

install \
  -o root \
  -g root \
  -m 0755 \
  "${SOURCE_BINARY}" \
  "${BIN_PATH}"

install \
  -o root \
  -g root \
  -m 0644 \
  "${SCRIPT_DIR}/config.yaml" \
  "${CONFIG_PATH}"

INSTALLED_SHA256="$(
  sha256sum "${BIN_PATH}" |
    awk '{print $1}'
)"

if [[ "${INSTALLED_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  fail "installed provider checksum verification failed"
fi

echo
echo "ECR credential provider installed:"
echo "  Binary: ${BIN_PATH}"
echo "  Config: ${CONFIG_PATH}"
echo "  SHA256: ${INSTALLED_SHA256}"
