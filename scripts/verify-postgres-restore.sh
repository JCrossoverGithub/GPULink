#!/usr/bin/env bash
set -euo pipefail
umask 0077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

backup_root="${GPULINK_BACKUP_ROOT:-/var/backups/gpulink/postgres}"
source_container="${GPULINK_POSTGRES_CONTAINER:-digitalocean-postgres-1}"

for command in docker sha256sum diff openssl flock; do
  command -v "${command}" >/dev/null 2>&1 \
    || die "${command} is required for PostgreSQL restore verification."
done

[[ -d ${backup_root} ]] \
  || die "Backup root does not exist: ${backup_root}"

exec 9>"${backup_root}/.restore-verification.lock"

if ! flock -n 9; then
  echo "Another GPUlink restore verification is already running."
  exit 0
fi

latest="$(
  find "${backup_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name 'backup-20??????T??????Z' \
    | sort \
    | tail -n 1
)"

[[ -n ${latest} ]] \
  || die "No completed PostgreSQL backup was found."

dump="${latest}/gpulink-postgres.dump"
checksum="${latest}/gpulink-postgres.dump.sha256"
expected_counts="${latest}/database-counts.txt"

for file in \
  "${dump}" \
  "${checksum}" \
  "${expected_counts}"
do
  [[ -r ${file} ]] \
    || die "Required backup artifact is not readable: ${file}"
done

echo "Verifying backup:"
echo "${latest}"

(
  cd "${latest}"
  sha256sum -c gpulink-postgres.dump.sha256
)

source_container_id_before="$(
  docker inspect \
    "${source_container}" \
    --format '{{.Id}}'
)"

source_started_before="$(
  docker inspect \
    "${source_container}" \
    --format '{{.State.StartedAt}}'
)"

source_image_id="$(
  docker inspect \
    "${source_container}" \
    --format '{{.Image}}'
)"

source_health="$(
  docker inspect \
    "${source_container}" \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
)"

[[ ${source_health} == "healthy" ]] \
  || die "Production PostgreSQL is not healthy: ${source_health}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_container="gpulink-postgres-restore-${timestamp}-$$"

restore_user=gpulink_restore
restore_db=gpulink_restore
restore_password="$(openssl rand -hex 32)"

actual_counts="$(mktemp)"

cleanup() {
  status=$?

  docker rm \
    -f \
    -v \
    "${restore_container}" \
    >/dev/null 2>&1 \
    || true

  rm -f \
    "${actual_counts}"

  exit "${status}"
}

trap cleanup EXIT

echo "Starting isolated disposable PostgreSQL..."

docker run \
  -d \
  --name "${restore_container}" \
  --network none \
  -e POSTGRES_USER="${restore_user}" \
  -e POSTGRES_PASSWORD="${restore_password}" \
  -e POSTGRES_DB=postgres \
  "${source_image_id}" \
  >/dev/null

#
# Prove the disposable container is not using the production data volume.
#
if docker inspect \
  "${restore_container}" \
  --format '{{range .Mounts}}{{println .Name}}{{end}}' \
  | grep -Fx \
      gpulink-postgres-data \
      >/dev/null
then
  die "Disposable restore unexpectedly mounted the production PostgreSQL volume."
fi

ready=0

for attempt in $(seq 1 60); do
  if docker exec \
    "${restore_container}" \
    pg_isready \
      -U "${restore_user}" \
      -d postgres \
    >/dev/null 2>&1
  then
    ready=1
    break
  fi

  running="$(
    docker inspect \
      "${restore_container}" \
      --format '{{.State.Running}}'
  )"

  if [[ ${running} != "true" ]]; then
    docker logs \
      "${restore_container}" \
      >&2

    die "Disposable PostgreSQL exited unexpectedly."
  fi

  sleep 1
done

[[ ${ready} == "1" ]] \
  || die "Disposable PostgreSQL did not become ready."

echo "Creating disposable restore database..."

docker exec \
  "${restore_container}" \
  createdb \
    -U "${restore_user}" \
    "${restore_db}"

database_exists="$(
  docker exec \
    "${restore_container}" \
    psql \
      -U "${restore_user}" \
      -d postgres \
      -Atc "SELECT COUNT(*) FROM pg_database WHERE datname = '${restore_db}';"
)"

[[ ${database_exists} == "1" ]] \
  || die "Disposable restore database was not created."

echo "Restore database ready: ${restore_db}"

echo "Restoring backup..."

docker exec \
  -i \
  "${restore_container}" \
  pg_restore \
    -U "${restore_user}" \
    -d "${restore_db}" \
    --exit-on-error \
    --no-owner \
    --no-acl \
  < "${dump}"

docker exec \
  "${restore_container}" \
  psql \
    -U "${restore_user}" \
    -d "${restore_db}" \
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
  > "${actual_counts}"

echo
echo "Expected database state:"
cat "${expected_counts}"

echo
echo "Restored database state:"
cat "${actual_counts}"

diff \
  -u \
  "${expected_counts}" \
  "${actual_counts}"

#
# Exercise representative reads beyond aggregate counts.
#
docker exec \
  "${restore_container}" \
  psql \
    -U "${restore_user}" \
    -d "${restore_db}" \
    -v ON_ERROR_STOP=1 \
    -Atc "
      SELECT COUNT(*)
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'workers',
          'jobs',
          'events',
          'gpulink_schema_migrations'
        );
    " \
  | grep -Fx 4 \
  >/dev/null \
  || die "Required restored tables are missing."

docker exec \
  "${restore_container}" \
  psql \
    -U "${restore_user}" \
    -d "${restore_db}" \
    -v ON_ERROR_STOP=1 \
    -Atc "
      SELECT COUNT(*)
      FROM gpulink_schema_migrations;
    " \
  | grep -Eq '^[1-9][0-9]*$' \
  || die "Restored schema migration history is empty."

source_container_id_after="$(
  docker inspect \
    "${source_container}" \
    --format '{{.Id}}'
)"

source_started_after="$(
  docker inspect \
    "${source_container}" \
    --format '{{.State.StartedAt}}'
)"

[[ ${source_container_id_before} == "${source_container_id_after}" ]] \
  || die "Production PostgreSQL container changed during restore verification."

[[ ${source_started_before} == "${source_started_after}" ]] \
  || die "Production PostgreSQL restarted during restore verification."

echo
echo "RESTORE VERIFICATION: PASS"
echo "backup=${latest}"
echo "production_postgres_untouched=true"
