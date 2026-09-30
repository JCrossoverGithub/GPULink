#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077

die() {
  echo "DISASTER RESTORE: FAIL: $*" >&2
  exit 1
}

: "${GPULINK_PGBACKREST_REPOSITORY_HOST:?repository endpoint is required}"
: "${GPULINK_RECOVERY_EXPECTED_VOLUME_ID:?expected volume ID is required}"
: "${GPULINK_RECOVERY_BACKUP_LABEL:?backup label is required}"
: "${GPULINK_RECOVERY_EXPECTED_SYSTEM_ID:?expected system identifier is required}"
: "${GPULINK_RECOVERY_MODE:?recovery mode is required}"
: "${GPULINK_RECOVERY_SCHEMA_STATE:?expected schema state is required}"

RECOVERY_TARGET="${GPULINK_RECOVERY_TARGET:-}"

DATA_ROOT="/var/lib/postgresql/data"
PGDATA="${DATA_ROOT}/pgdata"
SOCKET_DIR="/var/run/postgresql-recovery"
PORT="55436"

CONFIG="/tmp/gpulink-disaster-restore-pgbackrest.conf"
POSTGRES_LOG="/tmp/gpulink-disaster-restore-postgres.log"

REPOSITORY_HOST="${GPULINK_PGBACKREST_REPOSITORY_HOST}"
EXPECTED_VOLUME_ID="${GPULINK_RECOVERY_EXPECTED_VOLUME_ID}"
BACKUP_LABEL="${GPULINK_RECOVERY_BACKUP_LABEL}"
EXPECTED_SYSTEM_ID="${GPULINK_RECOVERY_EXPECTED_SYSTEM_ID}"
RECOVERY_MODE="${GPULINK_RECOVERY_MODE}"
EXPECTED_SCHEMA_STATE="${GPULINK_RECOVERY_SCHEMA_STATE}"

[[ "${EXPECTED_VOLUME_ID}" =~ ^vol-[0-9a-f]+$ ]] \
  || die "invalid expected EBS volume ID"

[[ "${EXPECTED_SYSTEM_ID}" =~ ^[0-9]+$ ]] \
  || die "invalid expected system identifier"

[[ "${BACKUP_LABEL}" =~ ^[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?$ ]] \
  || die "invalid pgBackRest backup label"

case "${RECOVERY_MODE}" in
  latest)
    [[ -z "${RECOVERY_TARGET}" ]] \
      || die "latest recovery must not specify a target"
    ;;
  name)
    [[ -n "${RECOVERY_TARGET}" ]] \
      || die "named recovery requires a target"
    ;;
  *)
    die "recovery mode must be latest or name"
    ;;
esac

case "${EXPECTED_SCHEMA_STATE}" in
  not-staged|present)
    ;;
  *)
    die "schema state must be not-staged or present"
    ;;
esac

MARKER="${DATA_ROOT}/.gpulink-storage-marker"

[[ -r "${MARKER}" ]] \
  || die "GPULink storage marker is missing"

grep -Fq "AWS volume: ${EXPECTED_VOLUME_ID}" "${MARKER}" \
  || die "storage marker does not match expected EBS volume"

[[ -d "${PGDATA}" ]] \
  || die "PGDATA directory is missing"

if find "${PGDATA}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  die "PGDATA is not empty; refusing authoritative restore"
fi

[[ -d "${SOCKET_DIR}" ]] \
  || die "recovery socket directory is missing"

unset PGBACKREST_CONFIG || true
unset PGBACKREST_STANZA || true
unset PGBACKREST_REPO1_HOST || true

cat > "${CONFIG}" <<EOF_CONFIG
[gpulink]
pg1-path=${PGDATA}
pg1-socket-path=${SOCKET_DIR}
pg1-user=gpulink
pg1-database=gpulink

[global]
repo1-host=${REPOSITORY_HOST}
repo1-host-type=tls
repo1-host-port=8432
repo1-host-config=/etc/pgbackrest/pgbackrest.conf
repo1-host-ca-file=/etc/pgbackrest/client-tls/ca.crt
repo1-host-cert-file=/etc/pgbackrest/client-tls/client.crt
repo1-host-key-file=/etc/pgbackrest/client-tls/client.key

log-level-console=info
log-level-file=off
EOF_CONFIG

export PGBACKREST_CONFIG="${CONFIG}"
export PGBACKREST_STANZA="gpulink"

for command in \
  pgbackrest \
  postgres \
  pg_ctl \
  pg_isready \
  psql \
  pg_controldata \
  find \
  grep \
  cut \
  head \
  sed \
  seq
do
  command -v "${command}" >/dev/null 2>&1 \
    || die "${command} is required"
done

POSTGRES_STARTED=0

cleanup() {
  status=$?

  if [[ "${POSTGRES_STARTED}" == "1" ]] \
    && [[ -f "${PGDATA}/postmaster.pid" ]]; then
    pg_ctl \
      -D "${PGDATA}" \
      -m fast \
      -w \
      -t 60 \
      stop \
      >/dev/null 2>&1 \
      || true
  fi

  if [[ ${status} -ne 0 ]] && [[ -r "${POSTGRES_LOG}" ]]; then
    echo >&2
    echo "===== PostgreSQL recovery log =====" >&2
    cat "${POSTGRES_LOG}" >&2
  fi

  rm -f "${CONFIG}" || true

  exit "${status}"
}

trap cleanup EXIT

echo "===== repository state ====="

INFO_JSON="$(
  pgbackrest \
    --config="${CONFIG}" \
    --stanza=gpulink \
    --repo=1 \
    --output=json \
    info
)"

printf '%s\n' "${INFO_JSON}"

REPOSITORY_SYSTEM_ID="$(
  printf '%s\n' "${INFO_JSON}" \
    | grep -o '"system-id":[0-9]*' \
    | head -n1 \
    | cut -d: -f2
)"

[[ "${REPOSITORY_SYSTEM_ID}" == "${EXPECTED_SYSTEM_ID}" ]] \
  || die "repository system identifier does not match operator expectation"

printf '%s\n' "${INFO_JSON}" \
  | grep -Fq "\"label\":\"${BACKUP_LABEL}\"" \
  || die "selected backup label is not present in repository"

echo "repository_system_identifier=${REPOSITORY_SYSTEM_ID}"
echo "selected_backup=${BACKUP_LABEL}"
echo "recovery_mode=${RECOVERY_MODE}"

if [[ "${RECOVERY_MODE}" == "name" ]]; then
  echo "recovery_target=${RECOVERY_TARGET}"
fi

RESTORE_ARGS=(
  --config="${CONFIG}"
  --stanza=gpulink
  --repo=1
  --set="${BACKUP_LABEL}"
  --archive-mode=preserve
)

case "${RECOVERY_MODE}" in
  latest)
    RESTORE_ARGS+=(--type=default)
    ;;
  name)
    RESTORE_ARGS+=(
      --type=name
      --target="${RECOVERY_TARGET}"
      --target-action=promote
    )
    ;;
esac

echo
echo "===== authoritative physical restore ====="

pgbackrest \
  "${RESTORE_ARGS[@]}" \
  restore

RESTORED_CONTROL_SYSTEM_ID="$(
  pg_controldata "${PGDATA}" \
    | sed -n \
      's/^Database system identifier:[[:space:]]*//p'
)"

[[ "${RESTORED_CONTROL_SYSTEM_ID}" == "${EXPECTED_SYSTEM_ID}" ]] \
  || die "restored system identifier does not match expected repository history"

echo "restored_control_system_identifier=${RESTORED_CONTROL_SYSTEM_ID}"

echo
echo "===== isolated recovery startup ====="

postgres \
  -D "${PGDATA}" \
  -c "listen_addresses=" \
  -c "port=${PORT}" \
  -c "unix_socket_directories=${SOCKET_DIR}" \
  -c "archive_mode=off" \
  >"${POSTGRES_LOG}" 2>&1 &

POSTGRES_PID=$!
POSTGRES_STARTED=1

ready=0

for attempt in $(seq 1 3600); do
  if ! kill -0 "${POSTGRES_PID}" >/dev/null 2>&1; then
    die "recovered PostgreSQL exited before becoming ready"
  fi

  if pg_isready \
    -h "${SOCKET_DIR}" \
    -p "${PORT}" \
    -U gpulink \
    -d gpulink \
    >/dev/null 2>&1
  then
    ready=1
    break
  fi

  sleep 1
done

[[ "${ready}" == "1" ]] \
  || die "recovered PostgreSQL did not become ready"

CORE_RESULT="$(
  psql \
    -h "${SOCKET_DIR}" \
    -p "${PORT}" \
    -U gpulink \
    -d gpulink \
    -v ON_ERROR_STOP=1 \
    -At \
    -F '|' \
    -c "
      SELECT
        system_identifier,
        (SELECT count(*) FROM public.gpulink_persistence_probe),
        pg_is_in_recovery(),
        current_setting('archive_mode'),
        current_setting('listen_addresses'),
        current_setting('port')
      FROM pg_control_system();
    "
)"

SYSTEM_ID="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f1)"
PROBE_ROWS="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f2)"
IN_RECOVERY="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f3)"
ARCHIVE_MODE="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f4)"
LISTEN_ADDRESSES="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f5)"
RECOVERY_PORT="$(printf '%s\n' "${CORE_RESULT}" | cut -d'|' -f6)"

APP_SCHEMA_TABLES="$(
  psql \
    -h "${SOCKET_DIR}" \
    -p "${PORT}" \
    -U gpulink \
    -d gpulink \
    -v ON_ERROR_STOP=1 \
    -Atc "
      SELECT count(*)
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'workers',
          'jobs',
          'events',
          'gpulink_schema_migrations'
        );
    "
)"

MIGRATIONS="not-staged"
WORKERS_COUNT="not-staged"
JOBS_COUNT="not-staged"
EVENTS_COUNT="not-staged"

case "${APP_SCHEMA_TABLES}" in
  0)
    [[ "${EXPECTED_SCHEMA_STATE}" == "not-staged" ]] \
      || die "application schema is absent but present was required"
    ;;

  4)
    [[ "${EXPECTED_SCHEMA_STATE}" == "present" ]] \
      || die "application schema is present but not-staged was required"

    APP_RESULT="$(
      psql \
        -h "${SOCKET_DIR}" \
        -p "${PORT}" \
        -U gpulink \
        -d gpulink \
        -v ON_ERROR_STOP=1 \
        -At \
        -F '|' \
        -c "
          SELECT
            (SELECT count(*) FROM public.workers),
            (SELECT count(*) FROM public.jobs),
            (SELECT count(*) FROM public.events),
            (SELECT count(*) FROM public.gpulink_schema_migrations);
        "
    )"

    WORKERS_COUNT="$(printf '%s\n' "${APP_RESULT}" | cut -d'|' -f1)"
    JOBS_COUNT="$(printf '%s\n' "${APP_RESULT}" | cut -d'|' -f2)"
    EVENTS_COUNT="$(printf '%s\n' "${APP_RESULT}" | cut -d'|' -f3)"
    MIGRATIONS="$(printf '%s\n' "${APP_RESULT}" | cut -d'|' -f4)"

    [[ "${MIGRATIONS}" =~ ^[1-9][0-9]*$ ]] \
      || die "staged application schema has empty migration history"
    ;;

  *)
    die "partial application schema detected: ${APP_SCHEMA_TABLES}/4"
    ;;
esac

[[ "${SYSTEM_ID}" == "${EXPECTED_SYSTEM_ID}" ]] \
  || die "running system identifier does not match expected repository history"

[[ "${PROBE_ROWS}" =~ ^[1-9][0-9]*$ ]] \
  || die "persistence probe is missing"

[[ "${IN_RECOVERY}" == "f" ]] \
  || die "PostgreSQL remained in recovery"

[[ "${ARCHIVE_MODE}" == "off" ]] \
  || die "isolated recovery unexpectedly enabled WAL archiving"

[[ -z "${LISTEN_ADDRESSES}" ]] \
  || die "isolated recovery unexpectedly enabled TCP"

[[ "${RECOVERY_PORT}" == "${PORT}" ]] \
  || die "unexpected isolated recovery port"

pg_ctl \
  -D "${PGDATA}" \
  -m fast \
  -w \
  -t 60 \
  stop

POSTGRES_STARTED=0

echo
echo "DISASTER RESTORE: PASS"
echo "backup=${BACKUP_LABEL}"
echo "recovery_mode=${RECOVERY_MODE}"
echo "system_identifier=${SYSTEM_ID}"
echo "probe_rows=${PROBE_ROWS}"
echo "application_schema_tables=${APP_SCHEMA_TABLES}/4"
echo "workers_count=${WORKERS_COUNT}"
echo "jobs_count=${JOBS_COUNT}"
echo "events_count=${EVENTS_COUNT}"
echo "schema_migrations=${MIGRATIONS}"
echo "authoritative_data_preserved=true"
echo "tcp_listener_enabled=false"
echo "archive_mode_during_validation=off"
