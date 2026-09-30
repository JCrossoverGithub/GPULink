#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077

die() {
  echo "DISASTER RESTORE WRAPPER: FAIL: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:

  run-restore.sh \
    --scope acceptance|production \
    --image <registry/repository@sha256:digest> \
    --target-pvc <pvc-name> \
    --host-mount <absolute-host-path> \
    --expected-volume-id <vol-...> \
    --backup-label <pgbackrest-label> \
    --expected-system-id <numeric-id> \
    --mode latest|name \
    --schema-state not-staged|present \
    [--target <named-restore-point>] \
    [--confirm-production <confirmation>] \
    [--execute]

Default behavior is preflight/render only.

--execute creates the two incident-local ConfigMaps and the one-shot Job.
It does not delete them automatically.

For production scope the required confirmation is:

  RESTORE-PRODUCTION-<volume-id>-<backup-label>
USAGE
}

SCOPE=""
IMAGE=""
TARGET_PVC=""
HOST_MOUNT=""
EXPECTED_VOLUME_ID=""
BACKUP_LABEL=""
EXPECTED_SYSTEM_ID=""
RECOVERY_MODE=""
SCHEMA_STATE=""
RECOVERY_TARGET=""
CONFIRM_PRODUCTION=""
EXECUTE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE="${2:?missing value for --scope}"
      shift 2
      ;;
    --image)
      IMAGE="${2:?missing value for --image}"
      shift 2
      ;;
    --target-pvc)
      TARGET_PVC="${2:?missing value for --target-pvc}"
      shift 2
      ;;
    --host-mount)
      HOST_MOUNT="${2:?missing value for --host-mount}"
      shift 2
      ;;
    --expected-volume-id)
      EXPECTED_VOLUME_ID="${2:?missing value for --expected-volume-id}"
      shift 2
      ;;
    --backup-label)
      BACKUP_LABEL="${2:?missing value for --backup-label}"
      shift 2
      ;;
    --expected-system-id)
      EXPECTED_SYSTEM_ID="${2:?missing value for --expected-system-id}"
      shift 2
      ;;
    --mode)
      RECOVERY_MODE="${2:?missing value for --mode}"
      shift 2
      ;;
    --schema-state)
      SCHEMA_STATE="${2:?missing value for --schema-state}"
      shift 2
      ;;
    --target)
      RECOVERY_TARGET="${2:?missing value for --target}"
      shift 2
      ;;
    --confirm-production)
      CONFIRM_PRODUCTION="${2:?missing value for --confirm-production}"
      shift 2
      ;;
    --execute)
      EXECUTE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] \
  || die "run this wrapper as root on the GPULink AWS host"

for command in \
  k3s \
  systemctl \
  python3 \
  lsblk \
  findmnt \
  readlink \
  blkid \
  grep \
  find \
  hostname \
  mktemp
do
  command -v "${command}" >/dev/null 2>&1 \
    || die "${command} is required"
done

for required in \
  SCOPE \
  IMAGE \
  TARGET_PVC \
  HOST_MOUNT \
  EXPECTED_VOLUME_ID \
  BACKUP_LABEL \
  EXPECTED_SYSTEM_ID \
  RECOVERY_MODE \
  SCHEMA_STATE
do
  [[ -n "${!required}" ]] \
    || die "${required} is required"
done

case "${SCOPE}" in
  acceptance|production)
    ;;
  *)
    die "--scope must be acceptance or production"
    ;;
esac

[[ "${TARGET_PVC}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] \
  || die "invalid Kubernetes PVC name"

[[ "${HOST_MOUNT}" == /* ]] \
  || die "host mount must be an absolute path"

[[ "${EXPECTED_VOLUME_ID}" =~ ^vol-[0-9a-f]+$ ]] \
  || die "invalid expected EBS volume ID"

[[ "${BACKUP_LABEL}" =~ ^[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?$ ]] \
  || die "invalid pgBackRest backup label"

[[ "${EXPECTED_SYSTEM_ID}" =~ ^[0-9]+$ ]] \
  || die "invalid expected system identifier"

case "${RECOVERY_MODE}" in
  latest)
    [[ -z "${RECOVERY_TARGET}" ]] \
      || die "latest recovery must not specify --target"
    ;;
  name)
    [[ -n "${RECOVERY_TARGET}" ]] \
      || die "named recovery requires --target"
    ;;
  *)
    die "--mode must be latest or name"
    ;;
esac

case "${SCHEMA_STATE}" in
  not-staged|present)
    ;;
  *)
    die "--schema-state must be not-staged or present"
    ;;
esac

SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
    pwd
)"

JOB_TEMPLATE="${SCRIPT_DIR}/postgres-disaster-restore-job.yaml"
RESTORE_SCRIPT="${SCRIPT_DIR}/restore.sh"

[[ -r "${JOB_TEMPLATE}" ]] \
  || die "Job template is missing"

[[ -r "${RESTORE_SCRIPT}" ]] \
  || die "restore script is missing"

NAMESPACE="gpulink"
PRODUCTION_PVC="postgres-data"
PRODUCTION_PV="gpulink-postgres-data-aws"
PRODUCTION_HOST_MOUNT="/var/lib/gpulink/postgres"

kube() {
  k3s kubectl "$@"
}

echo "===== recovery request ====="
echo "scope=${SCOPE}"
echo "target_pvc=${TARGET_PVC}"
echo "host_mount=${HOST_MOUNT}"
echo "expected_volume_id=${EXPECTED_VOLUME_ID}"
echo "backup_label=${BACKUP_LABEL}"
echo "expected_system_id=${EXPECTED_SYSTEM_ID}"
echo "recovery_mode=${RECOVERY_MODE}"
echo "schema_state=${SCHEMA_STATE}"
echo "execute=${EXECUTE}"

if [[ "${RECOVERY_MODE}" == "name" ]]; then
  echo "recovery_target=${RECOVERY_TARGET}"
fi

echo
echo "===== immutable image validation ====="

mapfile -t SENTINEL_IMAGES < <(
  grep -oE \
    'registry\.invalid/gpulink/postgres-pgbackrest@sha256:[0-9a-f]{64}' \
    "${JOB_TEMPLATE}" \
    | sort -u
)

[[ "${#SENTINEL_IMAGES[@]}" -eq 1 ]] \
  || die "Job template must contain exactly one unique image sentinel"

SENTINEL_IMAGE="${SENTINEL_IMAGES[0]}"
EXPECTED_DIGEST="${SENTINEL_IMAGE##*@}"

SENTINEL_COUNT="$(
  grep -cF "${SENTINEL_IMAGE}" "${JOB_TEMPLATE}"
)"

[[ "${SENTINEL_COUNT}" -eq 2 ]] \
  || die "expected exactly two image sentinel references"

[[ "${IMAGE}" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] \
  || die "image must be pinned by sha256 digest"

[[ "${IMAGE}" != registry.invalid/* ]] \
  || die "deployment image must not use registry.invalid"

[[ "${IMAGE##*@}" == "${EXPECTED_DIGEST}" ]] \
  || die "deployment image digest does not match accepted template digest"

echo "image_digest=${EXPECTED_DIGEST}"
echo "image_validation=PASS"

echo
echo "===== PVC / PV validation ====="

PVC_PHASE="$(
  kube get pvc "${TARGET_PVC}" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.status.phase}'
)"

[[ "${PVC_PHASE}" == "Bound" ]] \
  || die "target PVC is not Bound: ${PVC_PHASE}"

PV_NAME="$(
  kube get pvc "${TARGET_PVC}" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.spec.volumeName}'
)"

[[ -n "${PV_NAME}" ]] \
  || die "target PVC has no bound PV"

PV_RECLAIM="$(
  kube get pv "${PV_NAME}" \
    -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'
)"

[[ "${PV_RECLAIM}" == "Retain" ]] \
  || die "target PV reclaim policy is not Retain"

PV_STORAGE_CLASS="$(
  kube get pv "${PV_NAME}" \
    -o jsonpath='{.spec.storageClassName}'
)"

[[ "${PV_STORAGE_CLASS}" == "gpulink-postgres" ]] \
  || die "target PV uses unexpected StorageClass: ${PV_STORAGE_CLASS}"

PV_LOCAL_PATH="$(
  kube get pv "${PV_NAME}" \
    -o jsonpath='{.spec.local.path}'
)"

[[ "${PV_LOCAL_PATH}" == "${HOST_MOUNT}" ]] \
  || die "PV local path does not match requested host mount"

mapfile -t KUBERNETES_NODES < <(
  kube get nodes -o json |
    python3 -c '
import json
import sys

for node in json.load(sys.stdin).get("items", []):
    name = node.get("metadata", {}).get("name", "")
    if name:
        print(name)
'
)

[[ "${#KUBERNETES_NODES[@]}" -eq 1 ]] \
  || die "AWS reference recovery currently requires exactly one Kubernetes node"

CURRENT_NODE="${KUBERNETES_NODES[0]}"

PV_NODE_VALUES="$(
  kube get pv "${PV_NAME}" \
    -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[*].matchExpressions[*].values[*]}'
)"

NODE_MATCH=0
for value in ${PV_NODE_VALUES}; do
  if [[ "${value}" == "${CURRENT_NODE}" ]]; then
    NODE_MATCH=1
    break
  fi
done

[[ "${NODE_MATCH}" -eq 1 ]] \
  || die "target PV node affinity does not include the current Kubernetes node"

echo "pvc_phase=${PVC_PHASE}"
echo "pv=${PV_NAME}"
echo "pv_reclaim=${PV_RECLAIM}"
echo "pv_local_path=${PV_LOCAL_PATH}"
echo "pv_node=${CURRENT_NODE}"

echo
echo "===== PVC consumer validation ====="

POD_USERS="$(
  kube get pods -A -o json |
    python3 -c '
import json
import sys

namespace = sys.argv[1]
claim = sys.argv[2]
data = json.load(sys.stdin)

matches = []

for pod in data.get("items", []):
    pod_ns = pod.get("metadata", {}).get("namespace", "")
    if pod_ns != namespace:
        continue

    for volume in pod.get("spec", {}).get("volumes", []):
        pvc = volume.get("persistentVolumeClaim")
        if pvc and pvc.get("claimName") == claim:
            matches.append(
                pod_ns + "/" + pod.get("metadata", {}).get("name", "")
            )
            break

print("\n".join(matches))
' "${NAMESPACE}" "${TARGET_PVC}"
)"

if [[ -n "${POD_USERS}" ]]; then
  printf '%s\n' "${POD_USERS}" >&2
  die "target PVC is currently referenced by a Pod"
fi

echo "target_pvc_consumers=0"

echo
echo "===== host storage validation ====="

EXPECTED_SERIAL="${EXPECTED_VOLUME_ID//-/}"

mapfile -t MATCHING_DEVICES < <(
  lsblk -dn -o NAME,SERIAL |
    awk -v serial="${EXPECTED_SERIAL}" \
      '$2 == serial {print "/dev/" $1}'
)

[[ "${#MATCHING_DEVICES[@]}" -eq 1 ]] \
  || die "expected exactly one attached device for ${EXPECTED_VOLUME_ID}"

DEVICE="${MATCHING_DEVICES[0]}"

ROOT_SOURCE="$(readlink -f "$(findmnt -n -o SOURCE /)")"
ROOT_PARENT="$(lsblk -n -o PKNAME "${ROOT_SOURCE}" | head -n1 || true)"

if [[ -n "${ROOT_PARENT}" ]]; then
  ROOT_DISK="/dev/${ROOT_PARENT}"
else
  ROOT_DISK="${ROOT_SOURCE}"
fi

[[ "${DEVICE}" != "${ROOT_DISK}" ]] \
  || die "refusing to use root disk as recovery target"

findmnt -M "${HOST_MOUNT}" >/dev/null \
  || die "target host mount is not mounted"

MOUNT_SOURCE="$(
  readlink -f "$(findmnt -n -o SOURCE -M "${HOST_MOUNT}")"
)"

[[ "${MOUNT_SOURCE}" == "${DEVICE}" ]] \
  || die "host mount is backed by an unexpected device"

MARKER="${HOST_MOUNT}/.gpulink-storage-marker"

[[ -r "${MARKER}" ]] \
  || die "GPULink storage marker is missing"

grep -Fq "AWS volume: ${EXPECTED_VOLUME_ID}" "${MARKER}" \
  || die "storage marker belongs to a different EBS volume"

FILESYSTEM_UUID="$(blkid -s UUID -o value "${DEVICE}")"

[[ -n "${FILESYSTEM_UUID}" ]] \
  || die "filesystem UUID could not be determined"

grep -Fq "Filesystem UUID: ${FILESYSTEM_UUID}" "${MARKER}" \
  || die "storage marker filesystem UUID does not match mounted device"

HOST_PGDATA="${HOST_MOUNT}/pgdata"

if [[ -d "${HOST_PGDATA}" ]] \
  && find "${HOST_PGDATA}" -mindepth 1 -maxdepth 1 -print -quit \
    | grep -q .
then
  die "target PGDATA is not empty"
fi

echo "device=${DEVICE}"
echo "filesystem_uuid=${FILESYSTEM_UUID}"
echo "storage_marker=PASS"
echo "pgdata_empty=true"

echo
echo "===== scope safety validation ====="

if [[ "${SCOPE}" == "acceptance" ]]; then
  [[ "${TARGET_PVC}" != "${PRODUCTION_PVC}" ]] \
    || die "acceptance scope cannot target production PVC"

  [[ "${PV_NAME}" != "${PRODUCTION_PV}" ]] \
    || die "acceptance scope cannot target production PV"

  [[ "${HOST_MOUNT}" != "${PRODUCTION_HOST_MOUNT}" ]] \
    || die "acceptance scope cannot target production host mount"

  [[ -z "${CONFIRM_PRODUCTION}" ]] \
    || die "production confirmation is invalid in acceptance scope"

  echo "acceptance_isolation=PASS"
fi

if [[ "${SCOPE}" == "production" ]]; then
  [[ "${TARGET_PVC}" == "${PRODUCTION_PVC}" ]] \
    || die "production scope must target ${PRODUCTION_PVC}"

  [[ "${PV_NAME}" == "${PRODUCTION_PV}" ]] \
    || die "production PVC is not bound to expected production PV"

  [[ "${HOST_MOUNT}" == "${PRODUCTION_HOST_MOUNT}" ]] \
    || die "production scope must use ${PRODUCTION_HOST_MOUNT}"

  EXPECTED_CONFIRMATION="RESTORE-PRODUCTION-${EXPECTED_VOLUME_ID}-${BACKUP_LABEL}"

  [[ "${CONFIRM_PRODUCTION}" == "${EXPECTED_CONFIRMATION}" ]] \
    || die "production confirmation did not match required value"

  STATEFULSET_REPLICAS="$(
    kube get statefulset postgres \
      -n "${NAMESPACE}" \
      -o jsonpath='{.spec.replicas}'
  )"

  [[ "${STATEFULSET_REPLICAS}" == "0" ]] \
    || die "production PostgreSQL StatefulSet is not scaled to zero"

  POSTGRES_PODS="$(
    kube get pods \
      -n "${NAMESPACE}" \
      -l app.kubernetes.io/name=postgres \
      -o name
  )"

  [[ -z "${POSTGRES_PODS}" ]] \
    || die "production PostgreSQL Pod still exists"

  RESTORE_SUSPENDED="$(
    kube get cronjob postgres-restore-verification \
      -n "${NAMESPACE}" \
      -o jsonpath='{.spec.suspend}'
  )"

  [[ "${RESTORE_SUSPENDED}" == "true" ]] \
    || die "restore-verification CronJob is not suspended"

  if systemctl is-active --quiet gpulink-postgres-backup.timer; then
    die "backup timer is still active"
  fi

  if systemctl is-active --quiet gpulink-postgres-backup.service; then
    die "backup service is still active"
  fi

  echo "postgres_statefulset_replicas=0"
  echo "postgres_pods=0"
  echo "restore_verification_suspended=true"
  echo "backup_timer_inactive=true"
  echo "backup_service_inactive=true"
  echo "production_fencing=PASS"
fi

echo
echo "===== existing recovery-resource validation ====="

for resource in \
  "job/postgres-disaster-restore" \
  "configmap/postgres-disaster-restore-request" \
  "configmap/postgres-disaster-restore-script"
do
  if kube get "${resource}" \
    -n "${NAMESPACE}" \
    >/dev/null 2>&1
  then
    die "recovery resource already exists: ${resource}"
  fi
done

echo "existing_recovery_resources=0"

RENDERED_JOB="$(mktemp /tmp/gpulink-disaster-restore-job.XXXXXX.yaml)"
chmod 0600 "${RENDERED_JOB}"

cleanup_local() {
  rm -f "${RENDERED_JOB}"
}
trap cleanup_local EXIT

python3 - \
  "${JOB_TEMPLATE}" \
  "${RENDERED_JOB}" \
  "${SENTINEL_IMAGE}" \
  "${IMAGE}" \
  "${TARGET_PVC}" <<'PY'
from pathlib import Path
import sys

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
sentinel_image = sys.argv[3]
deployment_image = sys.argv[4]
target_pvc = sys.argv[5]

text = source_path.read_text()

if text.count(sentinel_image) != 2:
    raise SystemExit("ERROR: expected exactly two image sentinel references")

target_sentinel = "claimName: gpulink-disaster-restore-target"

if text.count(target_sentinel) != 1:
    raise SystemExit("ERROR: expected exactly one target PVC sentinel")

text = text.replace(sentinel_image, deployment_image)
text = text.replace(
    target_sentinel,
    f"claimName: {target_pvc}",
    1,
)

if "registry.invalid/" in text:
    raise SystemExit("ERROR: registry sentinel remained after render")

if "claimName: gpulink-disaster-restore-target" in text:
    raise SystemExit("ERROR: target PVC sentinel remained after render")

output_path.write_text(text)
PY

echo
echo "===== rendered Job validation ====="

RENDERED_IMAGE_COUNT="$(
  grep -cF "${IMAGE}" "${RENDERED_JOB}"
)"

[[ "${RENDERED_IMAGE_COUNT}" -eq 2 ]] \
  || die "rendered Job does not contain exactly two deployment image references"

RENDERED_TARGET_COUNT="$(
  grep -cF "claimName: ${TARGET_PVC}" "${RENDERED_JOB}"
)"

[[ "${RENDERED_TARGET_COUNT}" -eq 1 ]] \
  || die "rendered Job does not contain exactly one selected PVC"

kube apply \
  --dry-run=server \
  -f "${RENDERED_JOB}" \
  >/dev/null

echo "server_dry_run=PASS"

if [[ "${EXECUTE}" -eq 0 ]]; then
  echo
  echo "DISASTER RESTORE PREFLIGHT: PASS"
  echo "No Kubernetes resources were created."
  exit 0
fi

echo
echo "===== creating incident-local recovery resources ====="

kube create configmap postgres-disaster-restore-script \
  -n "${NAMESPACE}" \
  --from-file=restore.sh="${RESTORE_SCRIPT}"

kube create configmap postgres-disaster-restore-request \
  -n "${NAMESPACE}" \
  --from-literal=expected-volume-id="${EXPECTED_VOLUME_ID}" \
  --from-literal=backup-label="${BACKUP_LABEL}" \
  --from-literal=expected-system-id="${EXPECTED_SYSTEM_ID}" \
  --from-literal=recovery-mode="${RECOVERY_MODE}" \
  --from-literal=recovery-target="${RECOVERY_TARGET}" \
  --from-literal=schema-state="${SCHEMA_STATE}"

kube create \
  -f "${RENDERED_JOB}"

echo
echo "DISASTER RESTORE JOB CREATED"
echo
echo "Inspect with:"
echo
echo "  k3s kubectl get job postgres-disaster-restore -n ${NAMESPACE}"
echo "  k3s kubectl logs -n ${NAMESPACE} job/postgres-disaster-restore -f"
echo
echo "The wrapper does not delete recovery resources automatically."
