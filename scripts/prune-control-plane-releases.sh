#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  die "Run release pruning as root."
fi

retention_count="${GPULINK_RELEASE_RETENTION_COUNT:-5}"
release_root="${GPULINK_RELEASE_ROOT:-/root/gpulink-releases}"
archive_root="${GPULINK_RELEASE_ARCHIVE_ROOT:-/root}"

installed_revision_file="${GPULINK_INSTALLED_REVISION_FILE:-/opt/gpulink/RELEASE_REVISION}"
deployed_revision_file="${GPULINK_DEPLOYED_REVISION_FILE:-/opt/gpulink/DEPLOYED_CONTROL_PLANE_REVISION}"

[[ ${retention_count} =~ ^[1-9][0-9]*$ ]] \
  || die "GPULINK_RELEASE_RETENTION_COUNT must be a positive integer."

read_revision() {
  local file="$1"
  local revision

  [[ -r ${file} ]] \
    || die "Revision file is missing: ${file}"

  revision="$(
    tr -d '\r\n' \
      < "${file}"
  )"

  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] \
    || die "Invalid revision in ${file}"

  printf '%s' "${revision}"
}

installed_revision="$(
  read_revision "${installed_revision_file}"
)"

if [[ -r ${deployed_revision_file} ]]; then
  deployed_revision="$(
    read_revision "${deployed_revision_file}"
  )"
else
  deployed_revision="${installed_revision}"
fi

declare -A keep=()

installed_tag="${installed_revision:0:12}"
deployed_tag="${deployed_revision:0:12}"

keep["${installed_tag}"]=1
keep["${deployed_tag}"]=1

declare -a releases=()

for dir in "${release_root}"/gpulink-*; do
  [[ -d ${dir} ]] || continue
  [[ -r ${dir}/RELEASE_REVISION ]] || continue

  revision="$(
    tr -d '\r\n' \
      < "${dir}/RELEASE_REVISION"
  )"

  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] \
    || continue

  tag="${revision:0:12}"

  [[ $(basename "${dir}") == "gpulink-${tag}" ]] \
    || continue

  releases+=("${dir}")
done

mapfile -t ordered < <(
  if (( ${#releases[@]} > 0 )); then
    printf '%s\n' "${releases[@]}" |
      xargs ls -1dt
  fi
)

keep_count="${#keep[@]}"

for dir in "${ordered[@]}"; do
  revision="$(
    tr -d '\r\n' \
      < "${dir}/RELEASE_REVISION"
  )"

  tag="${revision:0:12}"

  if [[ -n ${keep[${tag}]+x} ]]; then
    continue
  fi

  if (( keep_count < retention_count )); then
    keep["${tag}"]=1
    keep_count=$((keep_count + 1))
  fi
done

for dir in "${ordered[@]}"; do
  revision="$(
    tr -d '\r\n' \
      < "${dir}/RELEASE_REVISION"
  )"

  tag="${revision:0:12}"

  if [[ -n ${keep[${tag}]+x} ]]; then
    if [[ ${revision} == "${deployed_revision}" ]]; then
      echo "KEEP deployed: gpulink-${tag}"
    elif [[ ${revision} == "${installed_revision}" ]]; then
      echo "KEEP installed: gpulink-${tag}"
    else
      echo "KEEP retained: gpulink-${tag}"
    fi

    continue
  fi

  echo "PRUNE traceable release: gpulink-${tag}"

  if docker image inspect \
    "gpulink-control-plane:${tag}" \
    >/dev/null 2>&1
  then
    docker image rm \
      "gpulink-control-plane:${tag}"
  fi

  rm -rf -- \
    "${dir}"

  rm -f -- \
    "${archive_root}/gpulink-${tag}.tar.gz"
done

echo
echo "RELEASE PRUNING: PASS"
