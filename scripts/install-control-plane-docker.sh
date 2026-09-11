#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  die "Run this installer with sudo."
fi

for command in docker openssl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    die "${command} is required before installing GPUlink."
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required before installing GPUlink."
fi

repository_root="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

install_root=/opt/gpulink
environment_file=/etc/gpulink/control-plane.env
postgres_environment_file=/etc/gpulink/postgres.env
compose_file="${install_root}/deploy/digitalocean/compose.yml"

read_env_value() {
  local file="$1"
  local key="$2"

  sed -n \
    "s/^${key}=//p" \
    "${file}" \
    | tail -n 1
}

require_env_value() {
  local file="$1"
  local key="$2"
  local value

  value="$(
    read_env_value \
      "${file}" \
      "${key}"
  )"

  if [[ -z ${value} ]]; then
    die "${file} is missing required setting ${key}"
  fi

  printf '%s' "${value}"
}

validate_existing_control_environment() {
  local database
  local database_url

  database="$(
    read_env_value \
      "${environment_file}" \
      GPULINK_CONTROL_DATABASE
  )"

  if [[ ${database} != "postgres" ]]; then
    die \
      "${environment_file} is not configured for PostgreSQL. Refusing to change an existing persistence backend automatically; migrate authoritative SQLite state first."
  fi

  database_url="$(
    read_env_value \
      "${environment_file}" \
      GPULINK_DATABASE_URL
  )"

  if [[ -z ${database_url} ]]; then
    die \
      "${environment_file} must define GPULINK_DATABASE_URL for PostgreSQL."
  fi

  require_env_value \
    "${environment_file}" \
    GPULINK_CLIENT_TOKEN \
    >/dev/null

  require_env_value \
    "${environment_file}" \
    GPULINK_WORKER_TOKEN \
    >/dev/null

  require_env_value \
    "${environment_file}" \
    GPULINK_ADMIN_TOKEN \
    >/dev/null

  if [[ ! -e ${postgres_environment_file} ]]; then
    die \
      "${postgres_environment_file} is missing for an existing PostgreSQL deployment. Refusing to generate replacement database credentials."
  fi

  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_USER \
    >/dev/null

  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_PASSWORD \
    >/dev/null

  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_DB \
    >/dev/null
}

wait_for_healthy() {
  local service="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0
  local container_id
  local status

  container_id="$(
    docker compose \
      -f "${compose_file}" \
      --profile postgres \
      ps -q "${service}"
  )"

  if [[ -z ${container_id} ]]; then
    die "Compose service ${service} did not create a container."
  fi

  while (( elapsed < timeout_seconds )); do
    status="$(
      docker inspect \
        --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "${container_id}" \
        2>/dev/null \
        || true
    )"

    case "${status}" in
      healthy)
        echo "${service} is healthy."
        return 0
        ;;

      exited|dead)
        docker compose \
          -f "${compose_file}" \
          --profile postgres \
          logs \
          --tail 100 \
          "${service}" \
          >&2 \
          || true

        die "${service} exited before becoming healthy."
        ;;
    esac

    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker compose \
    -f "${compose_file}" \
    --profile postgres \
    logs \
    --tail 100 \
    "${service}" \
    >&2 \
    || true

  die "${service} did not become healthy within ${timeout_seconds} seconds."
}

#
# Fail before modifying deployment files when an existing control
# plane is not already a valid PostgreSQL deployment.
#
if [[ -e ${environment_file} ]]; then
  validate_existing_control_environment

  echo \
    "Validated existing PostgreSQL control-plane configuration."
fi

install -d \
  -o root \
  -g root \
  -m 0755 \
  "${install_root}"

install -d \
  -o root \
  -g root \
  -m 0700 \
  /etc/gpulink

install -d \
  -o root \
  -g root \
  -m 0755 \
  "${install_root}/deploy/digitalocean"

install -d \
  -o root \
  -g root \
  -m 0755 \
  "${install_root}/scripts"

#
# A fresh installation needs PostgreSQL credentials before its
# control-plane connection URL can be generated.
#
if [[ ! -e ${postgres_environment_file} ]]; then
  umask 0077

  postgres_password="$(
    openssl rand -hex 32
  )"

  {
    echo "POSTGRES_USER=gpulink"
    echo "POSTGRES_PASSWORD=${postgres_password}"
    echo "POSTGRES_DB=gpulink"
  } > "${postgres_environment_file}"

  echo \
    "Created PostgreSQL credentials in ${postgres_environment_file}."
else
  echo \
    "Preserved existing PostgreSQL credentials in ${postgres_environment_file}."
fi

chown root:root \
  "${postgres_environment_file}"

chmod 0600 \
  "${postgres_environment_file}"

postgres_user="$(
  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_USER
)"

postgres_password="$(
  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_PASSWORD
)"

postgres_database="$(
  require_env_value \
    "${postgres_environment_file}" \
    POSTGRES_DB
)"

#
# Fresh Docker installations use PostgreSQL as authoritative
# storage. Existing environments were already validated above.
#
if [[ ! -e ${environment_file} ]]; then
  umask 0077

  client_token="$(
    openssl rand -hex 32
  )"

  worker_token="$(
    openssl rand -hex 32
  )"

  admin_token="$(
    openssl rand -hex 32
  )"

  {
    echo "GPULINK_CONTROL_HOST=0.0.0.0"
    echo "GPULINK_CONTROL_PORT=8088"
    echo "GPULINK_CONTROL_DATABASE=postgres"
    echo \
      "GPULINK_DATABASE_URL=postgresql://${postgres_user}:${postgres_password}@postgres:5432/${postgres_database}"
    echo \
      "GPULINK_CONTROL_DATA_PATH=/var/lib/gpulink/control-plane.sqlite"
    echo "GPULINK_CONTROL_HEARTBEAT_TIMEOUT_MS=15000"
    echo "GPULINK_CONTROL_LEASE_DURATION_MS=30000"
    echo "GPULINK_CONTROL_SCHEDULER_INTERVAL_MS=1000"
    echo "GPULINK_CONTROL_VRAM_SAFETY_MIB=512"
    echo "GPULINK_CLIENT_TOKEN=${client_token}"
    echo "GPULINK_WORKER_TOKEN=${worker_token}"
    echo "GPULINK_ADMIN_TOKEN=${admin_token}"
  } > "${environment_file}"

  echo \
    "Created PostgreSQL control-plane configuration in ${environment_file}."
else
  echo \
    "Preserved existing control-plane configuration in ${environment_file}."
fi

chown root:root \
  "${environment_file}"

chmod 0600 \
  "${environment_file}"

#
# Revalidate after fresh configuration generation.
#
validate_existing_control_environment

#
# Only after configuration is known safe do we replace installed
# application/deployment files.
#
cp -a \
  "${repository_root}/package.json" \
  "${repository_root}/package-lock.json" \
  "${repository_root}/src" \
  "${install_root}/"

cp -a \
  "${repository_root}/scripts/migrate-sqlite-to-postgres.mjs" \
  "${install_root}/scripts/"

cp -a \
  "${repository_root}/deploy/digitalocean/Dockerfile" \
  "${repository_root}/deploy/digitalocean/compose.yml" \
  "${install_root}/deploy/digitalocean/"

chown -R root:root \
  "${install_root}"

find "${install_root}" \
  -type d \
  -exec chmod 0755 {} +

find "${install_root}" \
  -type f \
  -exec chmod 0644 {} +

#
# Validate the complete Compose model before changing containers.
#
docker compose \
  -f "${compose_file}" \
  --profile postgres \
  config \
  --quiet

echo "Starting PostgreSQL..."

docker compose \
  -f "${compose_file}" \
  --profile postgres \
  up \
  -d \
  postgres

wait_for_healthy \
  postgres \
  120

echo "Building and starting GPUlink control plane..."

docker compose \
  -f "${compose_file}" \
  --profile postgres \
  up \
  -d \
  --build \
  control-plane

wait_for_healthy \
  control-plane \
  120

echo
docker compose \
  -f "${compose_file}" \
  --profile postgres \
  ps

echo
echo "GPUlink PostgreSQL deployment is healthy."
echo "Control plane is published only on 127.0.0.1:8088."
echo "PostgreSQL has no host-published port."
echo "Existing credentials and PostgreSQL data are preserved on reruns."
