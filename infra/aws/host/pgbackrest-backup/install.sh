#!/usr/bin/env bash
set -Eeuo pipefail
umask 0022

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] \
  || die "run this installer as root"

source_dir="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd
)"

for file in \
  backup.sh \
  gpulink-postgres-backup.service \
  gpulink-postgres-backup.timer
do
  [[ -r "${source_dir}/${file}" ]] \
    || die "missing installation artifact: ${file}"
done

id pgbackrest >/dev/null 2>&1 \
  || die "pgbackrest user does not exist"

command -v pgbackrest >/dev/null 2>&1 \
  || die "pgbackrest is not installed"

[[ -r /etc/pgbackrest/pgbackrest.conf ]] \
  || die "/etc/pgbackrest/pgbackrest.conf is not readable"

install \
  -o root \
  -g root \
  -m 0755 \
  "${source_dir}/backup.sh" \
  /usr/local/sbin/gpulink-pgbackrest-backup

install \
  -o root \
  -g root \
  -m 0644 \
  "${source_dir}/gpulink-postgres-backup.service" \
  /etc/systemd/system/gpulink-postgres-backup.service

install \
  -o root \
  -g root \
  -m 0644 \
  "${source_dir}/gpulink-postgres-backup.timer" \
  /etc/systemd/system/gpulink-postgres-backup.timer

systemctl daemon-reload

echo "GPULink pgBackRest backup automation installed."
echo
echo "The timer was NOT enabled."
echo "Run the service manually and validate it before enabling the timer."
