#!/usr/bin/env bash
set -Eeuo pipefail
umask 0027

die() {
  echo "BACKUP RESULT: FAIL: $*" >&2
  exit 1
}

config="${GPULINK_PGBACKREST_CONFIG:-/etc/pgbackrest/pgbackrest.conf}"
stanza="${GPULINK_PGBACKREST_STANZA:-gpulink}"
requested_type="${GPULINK_PGBACKREST_BACKUP_TYPE:-auto}"

for command in \
  pgbackrest \
  date \
  grep \
  cut \
  sort \
  tail
do
  command -v "${command}" >/dev/null 2>&1 \
    || die "${command} is required"
done

[[ -r "${config}" ]] \
  || die "pgBackRest configuration is not readable: ${config}"

case "${requested_type}" in
  auto)
    #
    # Sunday UTC gets a new full backup. All other scheduled runs are
    # incremental against the newest valid backup chain.
    #
    if [[ "$(date -u +%u)" == "7" ]]; then
      backup_type="full"
    else
      backup_type="incr"
    fi
    ;;
  full|diff|incr)
    backup_type="${requested_type}"
    ;;
  *)
    die "unsupported backup type: ${requested_type}"
    ;;
esac

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "===== GPULink PostgreSQL backup ====="
echo "started_at=${started_at}"
echo "stanza=${stanza}"
echo "backup_type=${backup_type}"

echo
echo "===== pre-backup repository check ====="

pgbackrest \
  --config="${config}" \
  --stanza="${stanza}" \
  check

echo
echo "===== backup ====="

pgbackrest \
  --config="${config}" \
  --stanza="${stanza}" \
  --type="${backup_type}" \
  backup

echo
echo "===== repository state ====="

info_json="$(
  pgbackrest \
    --config="${config}" \
    --stanza="${stanza}" \
    --output=json \
    info
)"

printf '%s\n' "${info_json}"

latest_label="$(
  printf '%s\n' "${info_json}" \
    | grep -o '"label":"[^"]*"' \
    | cut -d'"' -f4 \
    | sort \
    | tail -n 1
)"

[[ -n "${latest_label}" ]] \
  || die "backup completed but no valid backup label was found"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "BACKUP RESULT: PASS"
echo "backup_type=${backup_type}"
echo "backup=${latest_label}"
echo "started_at=${started_at}"
echo "completed_at=${completed_at}"
