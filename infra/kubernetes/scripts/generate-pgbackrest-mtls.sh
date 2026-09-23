#!/usr/bin/env bash
set -euo pipefail

umask 077

usage() {
  cat <<'USAGE'
Generate deployment-local pgBackRest mutual-TLS material.

Required:
  --database-server-san VALUE
      SAN used to verify the database-side pgBackRest server.
      Examples:
        IP:10.0.0.20
        DNS:postgres-pgbackrest.example.internal
        DNS:db.example.internal,IP:10.0.0.20

  --repository-server-san VALUE
      SAN used to verify the repository-side pgBackRest server.

Optional:
  --output-dir PATH
      Output directory.
      Default: $HOME/gpulink-secrets/pgbackrest

  --database-client-cn VALUE
      Default: gpulink-database

  --repository-client-cn VALUE
      Default: gpulink-repository

  --database-server-cn VALUE
      Default: gpulink-database-server

  --repository-server-cn VALUE
      Default: gpulink-repository-server

  --ca-cn VALUE
      Default: GPULink pgBackRest Private CA

  --ca-days N
      Default: 3650

  --leaf-days N
      Default: 825

The output directory must not be inside the current Git work tree.

This script creates private keys. Its output must never be committed.
USAGE
}

output_dir="${HOME}/gpulink-secrets/pgbackrest"

database_server_san=""
repository_server_san=""

database_client_cn="gpulink-database"
repository_client_cn="gpulink-repository"

database_server_cn="gpulink-database-server"
repository_server_cn="gpulink-repository-server"

ca_cn="GPULink pgBackRest Private CA"

ca_days="3650"
leaf_days="825"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-server-san)
      database_server_san="${2:?missing value}"
      shift 2
      ;;
    --repository-server-san)
      repository_server_san="${2:?missing value}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:?missing value}"
      shift 2
      ;;
    --database-client-cn)
      database_client_cn="${2:?missing value}"
      shift 2
      ;;
    --repository-client-cn)
      repository_client_cn="${2:?missing value}"
      shift 2
      ;;
    --database-server-cn)
      database_server_cn="${2:?missing value}"
      shift 2
      ;;
    --repository-server-cn)
      repository_server_cn="${2:?missing value}"
      shift 2
      ;;
    --ca-cn)
      ca_cn="${2:?missing value}"
      shift 2
      ;;
    --ca-days)
      ca_days="${2:?missing value}"
      shift 2
      ;;
    --leaf-days)
      leaf_days="${2:?missing value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$database_server_san" ]]; then
  echo "ERROR: --database-server-san is required" >&2
  exit 2
fi

if [[ -z "$repository_server_san" ]]; then
  echo "ERROR: --repository-server-san is required" >&2
  exit 2
fi

command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required" >&2
  exit 1
}

command -v realpath >/dev/null 2>&1 || {
  echo "ERROR: realpath is required" >&2
  exit 1
}

validate_cn() {
  local value="$1"
  local label="$2"

  if [[ -z "$value" || "$value" == *"/"* || "$value" == *$'\n'* ]]; then
    echo "ERROR: invalid ${label}: ${value}" >&2
    exit 2
  fi
}

validate_san() {
  local value="$1"
  local item

  IFS=',' read -r -a items <<<"$value"

  for item in "${items[@]}"; do
    case "$item" in
      DNS:*|IP:*)
        ;;
      *)
        echo "ERROR: invalid SAN entry '${item}'" >&2
        echo "       SAN entries must begin with DNS: or IP:" >&2
        exit 2
        ;;
    esac
  done
}

validate_cn "$database_client_cn" "database client CN"
validate_cn "$repository_client_cn" "repository client CN"
validate_cn "$database_server_cn" "database server CN"
validate_cn "$repository_server_cn" "repository server CN"
validate_cn "$ca_cn" "CA CN"

validate_san "$database_server_san"
validate_san "$repository_server_san"

if ! [[ "$ca_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --ca-days must be a positive integer" >&2
  exit 2
fi

if ! [[ "$leaf_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --leaf-days must be a positive integer" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
output_abs="$(realpath -m "$output_dir")"

if [[ -n "$repo_root" ]]; then
  repo_abs="$(realpath "$repo_root")"

  if [[ "$output_abs" == "$repo_abs" || "$output_abs" == "$repo_abs/"* ]]; then
    echo "ERROR: refusing to generate PKI material inside the Git work tree:" >&2
    echo "       ${output_abs}" >&2
    exit 1
  fi
fi

if [[ -e "$output_abs" ]] && find "$output_abs" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
  echo "ERROR: output directory is not empty:" >&2
  echo "       ${output_abs}" >&2
  exit 1
fi

mkdir -p \
  "$output_abs/database" \
  "$output_abs/repository"

chmod 0700 \
  "$output_abs" \
  "$output_abs/database" \
  "$output_abs/repository"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

issue_server_certificate() {
  local name="$1"
  local cn="$2"
  local san="$3"
  local destination="$4"

  local csr="${work_dir}/${name}.csr"
  local ext="${work_dir}/${name}.ext"

  openssl req \
    -new \
    -newkey rsa:3072 \
    -nodes \
    -sha256 \
    -subj "/CN=${cn}" \
    -keyout "${destination}/server.key" \
    -out "$csr" \
    >/dev/null 2>&1

  cat >"$ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
subjectAltName=${san}
EXT

  openssl x509 \
    -req \
    -sha256 \
    -days "$leaf_days" \
    -in "$csr" \
    -CA "${output_abs}/ca.crt" \
    -CAkey "${output_abs}/ca.key" \
    -CAserial "${work_dir}/ca.srl" \
    -CAcreateserial \
    -extfile "$ext" \
    -out "${destination}/server.crt" \
    >/dev/null 2>&1
}

issue_client_certificate() {
  local name="$1"
  local cn="$2"
  local destination="$3"

  local csr="${work_dir}/${name}.csr"
  local ext="${work_dir}/${name}.ext"

  openssl req \
    -new \
    -newkey rsa:3072 \
    -nodes \
    -sha256 \
    -subj "/CN=${cn}" \
    -keyout "${destination}/client.key" \
    -out "$csr" \
    >/dev/null 2>&1

  cat >"$ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EXT

  openssl x509 \
    -req \
    -sha256 \
    -days "$leaf_days" \
    -in "$csr" \
    -CA "${output_abs}/ca.crt" \
    -CAkey "${output_abs}/ca.key" \
    -CAserial "${work_dir}/ca.srl" \
    -extfile "$ext" \
    -out "${destination}/client.crt" \
    >/dev/null 2>&1
}

openssl req \
  -x509 \
  -newkey rsa:4096 \
  -nodes \
  -sha256 \
  -days "$ca_days" \
  -subj "/CN=${ca_cn}" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "${output_abs}/ca.key" \
  -out "${output_abs}/ca.crt" \
  >/dev/null 2>&1

issue_server_certificate \
  "database-server" \
  "$database_server_cn" \
  "$database_server_san" \
  "${output_abs}/database"

issue_client_certificate \
  "database-client" \
  "$database_client_cn" \
  "${output_abs}/database"

issue_server_certificate \
  "repository-server" \
  "$repository_server_cn" \
  "$repository_server_san" \
  "${output_abs}/repository"

issue_client_certificate \
  "repository-client" \
  "$repository_client_cn" \
  "${output_abs}/repository"

cp "${output_abs}/ca.crt" "${output_abs}/database/ca.crt"
cp "${output_abs}/ca.crt" "${output_abs}/repository/ca.crt"

chmod 0600 \
  "${output_abs}/ca.key" \
  "${output_abs}/database/server.key" \
  "${output_abs}/database/client.key" \
  "${output_abs}/repository/server.key" \
  "${output_abs}/repository/client.key"

chmod 0644 \
  "${output_abs}/ca.crt" \
  "${output_abs}/database/ca.crt" \
  "${output_abs}/database/server.crt" \
  "${output_abs}/database/client.crt" \
  "${output_abs}/repository/ca.crt" \
  "${output_abs}/repository/server.crt" \
  "${output_abs}/repository/client.crt"

openssl verify \
  -CAfile "${output_abs}/ca.crt" \
  "${output_abs}/database/server.crt" \
  "${output_abs}/database/client.crt" \
  "${output_abs}/repository/server.crt" \
  "${output_abs}/repository/client.crt"

openssl verify \
  -purpose sslserver \
  -CAfile "${output_abs}/ca.crt" \
  "${output_abs}/database/server.crt" \
  "${output_abs}/repository/server.crt"

openssl verify \
  -purpose sslclient \
  -CAfile "${output_abs}/ca.crt" \
  "${output_abs}/database/client.crt" \
  "${output_abs}/repository/client.crt"

echo
echo "pgBackRest mTLS material generated."
echo
echo "Output:"
echo "  ${output_abs}"
echo
echo "Database side:"
echo "  ${output_abs}/database"
echo
echo "Repository side:"
echo "  ${output_abs}/repository"
echo
echo "CA signing key:"
echo "  ${output_abs}/ca.key"
echo
echo "  Keep this file offline/private. Do not deploy it to Kubernetes or the repository host."
echo
echo "Client identities:"
echo "  database:   ${database_client_cn}"
echo "  repository: ${repository_client_cn}"
echo
echo "Server SANs:"
echo "  database:   ${database_server_san}"
echo "  repository: ${repository_server_san}"
echo
echo "CA SHA-256 fingerprint:"
openssl x509 \
  -in "${output_abs}/ca.crt" \
  -noout \
  -fingerprint \
  -sha256
