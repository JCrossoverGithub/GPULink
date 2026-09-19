#!/usr/bin/env bash
set -Eeuo pipefail

VOLUME_ID="${1:-}"
MOUNT_POINT="${2:-/var/lib/gpulink/postgres}"
FILESYSTEM_LABEL="gpulink-pgdata"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run this script as root"
fi

if [[ ! "${VOLUME_ID}" =~ ^vol-[0-9a-f]+$ ]]; then
  fail "usage: $0 vol-xxxxxxxxxxxxxxxxx [mount-point]"
fi

EXPECTED_SERIAL="${VOLUME_ID//-/}"

echo "Expected EBS volume: ${VOLUME_ID}"
echo "Expected NVMe serial: ${EXPECTED_SERIAL}"
echo "Mount point:          ${MOUNT_POINT}"

mapfile -t MATCHING_DEVICES < <(
  lsblk -dn -o NAME,SERIAL |
    awk -v serial="${EXPECTED_SERIAL}" \
      '$2 == serial {print "/dev/" $1}'
)

if [[ "${#MATCHING_DEVICES[@]}" -eq 0 ]]; then
  fail "could not find an attached device for ${VOLUME_ID}"
fi

if [[ "${#MATCHING_DEVICES[@]}" -ne 1 ]]; then
  fail "expected exactly one device for ${VOLUME_ID}"
fi

DEVICE="${MATCHING_DEVICES[0]}"

ROOT_SOURCE="$(readlink -f "$(findmnt -n -o SOURCE /)")"
ROOT_PARENT="$(lsblk -n -o PKNAME "${ROOT_SOURCE}" | head -n1 || true)"

if [[ -n "${ROOT_PARENT}" ]]; then
  ROOT_DISK="/dev/${ROOT_PARENT}"
else
  ROOT_DISK="${ROOT_SOURCE}"
fi

echo "Root disk:            ${ROOT_DISK}"
echo "PostgreSQL disk:      ${DEVICE}"

if [[ "${DEVICE}" == "${ROOT_DISK}" ]]; then
  fail "refusing to operate on the root disk"
fi

FSTYPE="$(lsblk -dn -o FSTYPE "${DEVICE}" | xargs)"

if [[ -z "${FSTYPE}" ]]; then
  echo "No filesystem detected."

  if wipefs -n "${DEVICE}" | grep -q .; then
    wipefs -n "${DEVICE}" >&2
    fail "unexpected disk signatures found; refusing to format"
  fi

  echo "Creating ext4 filesystem..."
  mkfs.ext4 -L "${FILESYSTEM_LABEL}" "${DEVICE}"
elif [[ "${FSTYPE}" != "ext4" ]]; then
  fail "unexpected filesystem type ${FSTYPE}; expected ext4"
else
  echo "Existing ext4 filesystem detected; preserving it."
fi

CURRENT_LABEL="$(blkid -s LABEL -o value "${DEVICE}" || true)"

if [[ "${CURRENT_LABEL}" != "${FILESYSTEM_LABEL}" ]]; then
  fail "unexpected filesystem label '${CURRENT_LABEL}'"
fi

FILESYSTEM_UUID="$(blkid -s UUID -o value "${DEVICE}")"

if [[ -z "${FILESYSTEM_UUID}" ]]; then
  fail "filesystem UUID could not be determined"
fi

echo "Filesystem UUID:      ${FILESYSTEM_UUID}"

mkdir -p "${MOUNT_POINT}"

DESIRED_SOURCE="UUID=${FILESYSTEM_UUID}"
EXISTING_SOURCE="$(
  awk -v mount_point="${MOUNT_POINT}" \
    '$2 == mount_point {print $1}' /etc/fstab |
    tail -n1
)"

if [[ -z "${EXISTING_SOURCE}" ]]; then
  echo "Adding persistent /etc/fstab entry."

  cp -a \
    /etc/fstab \
    "/etc/fstab.before-gpulink-$(date +%Y%m%d-%H%M%S)"

  printf 'UUID=%s %s ext4 defaults,noatime 0 2\n' \
    "${FILESYSTEM_UUID}" \
    "${MOUNT_POINT}" \
    >> /etc/fstab
elif [[ "${EXISTING_SOURCE}" != "${DESIRED_SOURCE}" ]]; then
  fail "${MOUNT_POINT} already has a different /etc/fstab source: ${EXISTING_SOURCE}"
else
  echo "Correct /etc/fstab entry already exists."
fi

systemctl daemon-reload
mount -a

if ! findmnt -M "${MOUNT_POINT}" >/dev/null; then
  fail "${MOUNT_POINT} did not mount"
fi

MOUNT_SOURCE="$(readlink -f "$(findmnt -n -o SOURCE -M "${MOUNT_POINT}")")"

if [[ "${MOUNT_SOURCE}" != "${DEVICE}" ]]; then
  fail "${MOUNT_POINT} resolved to ${MOUNT_SOURCE}, expected ${DEVICE}"
fi

MARKER="${MOUNT_POINT}/.gpulink-storage-marker"

if [[ -e "${MARKER}" ]]; then
  grep -Fq "AWS volume: ${VOLUME_ID}" "${MARKER}" ||
    fail "existing storage marker belongs to a different AWS volume"

  grep -Fq "Filesystem UUID: ${FILESYSTEM_UUID}" "${MARKER}" ||
    fail "existing storage marker contains a different filesystem UUID"

  echo "Existing GPULink storage marker verified."
else
  cat > "${MARKER}" <<MARKER_EOF
GPULink PostgreSQL persistent volume
AWS volume: ${VOLUME_ID}
Filesystem UUID: ${FILESYSTEM_UUID}
Initialized: $(date -u --iso-8601=seconds)
MARKER_EOF

  sync
  echo "Created GPULink storage marker."
fi

echo
echo "PostgreSQL storage ready:"
echo "  AWS volume: ${VOLUME_ID}"
echo "  Device:     ${DEVICE}"
echo "  Filesystem: ext4"
echo "  UUID:       ${FILESYSTEM_UUID}"
echo "  Mount:      ${MOUNT_POINT}"

findmnt -M "${MOUNT_POINT}"
