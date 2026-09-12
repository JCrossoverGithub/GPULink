#!/usr/bin/env bash
set -euo pipefail
umask 0077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  die "Run this rollback command as root."
fi

if [[ $# -ne 1 ]]; then
  die "Usage: $0 <40-character-release-revision>"
fi

target_revision="${1,,}"

if [[ ! ${target_revision} =~ ^[0-9a-f]{40}$ ]]; then
  die "Target revision must be a full 40-character Git SHA."
fi

for command in docker flock systemctl curl; do
  command -v "${command}" >/dev/null 2>&1 \
    || die "${command} is required."
done

docker compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 is required."

install_root=/opt/gpulink
release_root=/root/gpulink-releases
postgres_env=/etc/gpulink/postgres.env

installed_revision_file="${install_root}/RELEASE_REVISION"
deployed_revision_file="${install_root}/DEPLOYED_CONTROL_PLANE_REVISION"

[[ -r ${installed_revision_file} ]] \
  || die "Installed release revision is not recorded."

installed_revision="$(
  tr -d '\r\n' \
    < "${installed_revision_file}"
)"

[[ ${installed_revision} =~ ^[0-9a-f]{40}$ ]] \
  || die "Installed release revision is invalid."

if [[ -r ${deployed_revision_file} ]]; then
  current_revision="$(
    tr -d '\r\n' \
      < "${deployed_revision_file}"
  )"
else
  current_revision="${installed_revision}"
fi

[[ ${current_revision} =~ ^[0-9a-f]{40}$ ]] \
  || die "Current deployed control-plane revision is invalid."

current_tag="${current_revision:0:12}"
current_dir="${release_root}/gpulink-${current_tag}"
current_release_revision_file="${current_dir}/RELEASE_REVISION"
current_compose="${current_dir}/deploy/digitalocean/compose.yml"
current_image="gpulink-control-plane:${current_tag}"

target_tag="${target_revision:0:12}"
target_dir="${release_root}/gpulink-${target_tag}"
target_revision_file="${target_dir}/RELEASE_REVISION"
target_compose="${target_dir}/deploy/digitalocean/compose.yml"
target_image="gpulink-control-plane:${target_tag}"

[[ -r ${current_release_revision_file} ]] \
  || die "Current deployed release directory is missing traceable revision metadata."

recorded_current="$(
  tr -d '\r\n' \
    < "${current_release_revision_file}"
)"

[[ ${recorded_current} == "${current_revision}" ]] \
  || die "Current release directory revision does not match deployed revision."

[[ -r ${current_compose} ]] \
  || die "Current deployed release Compose file is missing."

if [[ ${target_revision} == "${current_revision}" ]]; then
  die "Target revision is already deployed."
fi

[[ -d ${target_dir} ]] \
  || die "Target release directory does not exist: ${target_dir}"

[[ -r ${target_revision_file} ]] \
  || die "Target release is legacy or untraceable; RELEASE_REVISION is missing."

recorded_target="$(
  tr -d '\r\n' \
    < "${target_revision_file}"
)"

[[ ${recorded_target} == "${target_revision}" ]] \
  || die "Target release directory revision does not match requested revision."

[[ -r ${target_compose} ]] \
  || die "Target release Compose file is missing."

docker image inspect \
  "${target_image}" \
  >/dev/null 2>&1 \
  || die "Target immutable image is not retained locally: ${target_image}"

target_image_revision="$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${target_image}"
)"

target_image_version="$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${target_image}"
)"

[[ ${target_image_revision} == "${target_revision}" ]] \
  || die "Target image revision label does not match requested revision."

[[ ${target_image_version} == "${target_tag}" ]] \
  || die "Target image version label does not match requested tag."

docker image inspect \
  "${current_image}" \
  >/dev/null 2>&1 \
  || die "Current immutable image is missing: ${current_image}"

current_image_revision="$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${current_image}"
)"

[[ ${current_image_revision} == "${current_revision}" ]] \
  || die "Current image identity does not match deployed revision."

[[ -r ${postgres_env} ]] \
  || die "PostgreSQL environment file is missing."

#
# Prevent two deployment/rollback operations from running concurrently.
#
exec 9>/run/lock/gpulink-control-plane-deploy.lock

flock -n 9 \
  || die "Another GPUlink deployment or rollback is already running."

set -a
source "${postgres_env}"
set +a

for key in POSTGRES_USER POSTGRES_DB; do
  [[ -n ${!key:-} ]] \
    || die "${postgres_env} is missing ${key}."
done

echo "Current revision: ${current_revision}"
echo "Target revision : ${target_revision}"
echo

echo "Checking active jobs..."

active_jobs="$(
  docker compose \
    --project-name digitalocean \
    -f "${current_compose}" \
    --profile postgres \
    exec -T postgres \
    psql \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" \
      -Atc "
        SELECT COUNT(*)
        FROM jobs
        WHERE status IN ('queued', 'leased', 'running');
      "
)"

echo "active_jobs=${active_jobs}"

[[ ${active_jobs} == "0" ]] \
  || die "Rollback refused while active jobs exist."

echo "Creating pre-rollback PostgreSQL backup..."

systemctl start \
  gpulink-postgres-backup.service

backup_result="$(
  systemctl show \
    gpulink-postgres-backup.service \
    -p Result \
    --value
)"

[[ ${backup_result} == "success" ]] \
  || die "Pre-rollback PostgreSQL backup failed."

wait_for_control_plane() {
  local elapsed=0
  local timeout=120
  local container_id
  local health

  while (( elapsed < timeout )); do
    container_id="$(
      docker compose \
        --project-name digitalocean \
        -f "$1" \
        --profile postgres \
        ps -q control-plane
    )"

    if [[ -n ${container_id} ]]; then
      health="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "${container_id}"
      )"

      case "${health}" in
        healthy)
          return 0
          ;;
        unhealthy|exited|dead)
          return 1
          ;;
      esac
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  return 1
}

restore_current_release() {
  echo
  echo "Target release failed health validation."
  echo "Restoring current release ${current_revision}..." >&2

  export GPULINK_RELEASE_REVISION="${current_revision}"
  export GPULINK_RELEASE_TAG="${current_tag}"

  docker compose \
    --project-name digitalocean \
    -f "${current_compose}" \
    --profile postgres \
    up \
    -d \
    --no-build \
    control-plane

  if wait_for_control_plane \
    "${current_compose}"
  then
    echo "Original release restored successfully." >&2
  else
    echo "CRITICAL: original release also failed health validation." >&2
  fi
}

echo
echo "Switching control plane to ${target_image}..."

export GPULINK_RELEASE_REVISION="${target_revision}"
export GPULINK_RELEASE_TAG="${target_tag}"

if ! docker compose \
  --project-name digitalocean \
  -f "${target_compose}" \
  --profile postgres \
  up \
  -d \
  --no-build \
  control-plane
then
  restore_current_release
  die "Rollback container switch failed."
fi

if ! wait_for_control_plane \
  "${target_compose}"
then
  restore_current_release
  die "Rollback target failed health validation."
fi

running_image="$(
  docker inspect \
    digitalocean-control-plane-1 \
    --format '{{.Config.Image}}'
)"

if [[ ${running_image} != "${target_image}" ]]; then
  restore_current_release
  die "Running container does not use the requested target image."
fi

curl -fsS \
  http://127.0.0.1:8088/healthz \
  >/dev/null \
  || {
    restore_current_release
    die "Rollback target failed /healthz."
  }

curl -fsS \
  http://127.0.0.1:8088/readyz \
  >/dev/null \
  || {
    restore_current_release
    die "Rollback target failed /readyz."
  }

printf '%s\n' \
  "${target_revision}" \
  > "${deployed_revision_file}"

chmod 0644 \
  "${deployed_revision_file}"

echo
echo "ROLLBACK RESULT: PASS"
echo "previous_revision=${current_revision}"
echo "deployed_revision=${target_revision}"
echo "image=${target_image}"
