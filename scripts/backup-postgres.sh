#!/usr/bin/env bash
set -euo pipefail
umask 0077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

backup_root="${GPULINK_BACKUP_ROOT:-/var/backups/gpulink/postgres}"
compose_file="${GPULINK_COMPOSE_FILE:-/opt/gpulink/deploy/digitalocean/compose.yml}"
postgres_env_file="${GPULINK_POSTGRES_ENV_FILE:-/etc/gpulink/postgres.env}"
retention_count="${GPULINK_BACKUP_RETENTION_COUNT:-14}"

if [[ ! ${retention_count} =~ ^[1-9][0-9]*$ ]]; then
  die "GPULINK_BACKUP_RETENTION_COUNT must be a positive integer."
fi

for command in docker flock sha256sum; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    die "${command} is required for PostgreSQL backups."
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required for PostgreSQL backups."
fi

if [[ ! -r ${postgres_env_file} ]]; then
  die "PostgreSQL environment file is not readable: ${postgres_env_file}"
fi

if [[ ! -r ${compose_file} ]]; then
  die "Compose file is not readable: ${compose_file}"
fi

mkdir -p "${backup_root}"
chmod 0700 "${backup_root}"

exec 9>"${backup_root}/.backup.lock"

if ! flock -n 9; then
  echo "Another GPUlink PostgreSQL backup is already running."
  exit 0
fi

set -a
source "${postgres_env_file}"
set +a

for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  if [[ -z ${!key:-} ]]; then
    die "${postgres_env_file} is missing ${key}."
  fi
done

compose=(
  docker compose
  -f "${compose_file}"
  --profile postgres
)

container_id="$(
  "${compose[@]}" ps -q postgres
)"

if [[ -z ${container_id} ]]; then
  die "PostgreSQL container is not running."
fi

postgres_health="$(
  docker inspect \
    --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "${container_id}"
)"

if [[ ${postgres_health} != "healthy" ]]; then
  die "PostgreSQL container is not healthy: ${postgres_health}"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_dir="${backup_root}/backup-${timestamp}"
temp_dir="${backup_root}/.incomplete-${timestamp}-$$"

if [[ -e ${final_dir} ]]; then
  die "Backup destination already exists: ${final_dir}"
fi

mkdir "${temp_dir}"

cleanup() {
  status=$?

  if [[ -d ${temp_dir:-} ]]; then
    rm -rf -- "${temp_dir}"
  fi

  exit "${status}"
}

trap cleanup EXIT

echo "Creating PostgreSQL backup..."

"${compose[@]}" exec -T postgres \
  pg_dump \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --format=custom \
    --no-owner \
    --no-acl \
  > "${temp_dir}/gpulink-postgres.dump"

(
  cd "${temp_dir}"

  sha256sum \
    gpulink-postgres.dump \
    > gpulink-postgres.dump.sha256

  sha256sum \
    -c gpulink-postgres.dump.sha256
)

echo "Validating backup structure..."

"${compose[@]}" exec -T postgres \
  pg_restore \
    --list \
  < "${temp_dir}/gpulink-postgres.dump" \
  > "${temp_dir}/pg_restore-list.txt"

echo "Recording database state..."

"${compose[@]}" exec -T postgres \
  psql \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -Atc "
      SELECT 'workers=' || COUNT(*) FROM workers;
      SELECT 'jobs=' || COUNT(*) FROM jobs;
      SELECT 'events=' || COUNT(*) FROM events;
      SELECT 'max_event_sequence=' || COALESCE(MAX(sequence), 0)
      FROM events;

      SELECT 'job_status.' || status || '=' || COUNT(*)
      FROM jobs
      GROUP BY status
      ORDER BY status;
    " \
  > "${temp_dir}/database-counts.txt"

{
  echo "created_at=${timestamp}"
  echo "database=${POSTGRES_DB}"
  echo "format=postgres-custom"
  echo "retention_count=${retention_count}"
  echo "postgres_container=${container_id}"
} > "${temp_dir}/metadata.txt"

#
# The rename occurs only after the dump, checksum, pg_restore
# inspection, and state capture have all succeeded.
#
mv \
  "${temp_dir}" \
  "${final_dir}"

echo "Backup verified and committed:"
echo "${final_dir}"

#
# Retention applies only to completed backup-* directories.
# Incomplete directories are never interpreted as valid backups.
#
mapfile -t completed_backups < <(
  find "${backup_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name 'backup-20??????T??????Z' \
    -printf '%f\n' \
    | sort -r
)

if (( ${#completed_backups[@]} > retention_count )); then
  for expired in "${completed_backups[@]:retention_count}"; do
    echo "Removing expired backup: ${expired}"

    rm -rf -- \
      "${backup_root}/${expired}"
  done
fi

echo
echo "BACKUP RESULT: PASS"
echo "backup=${final_dir}"
