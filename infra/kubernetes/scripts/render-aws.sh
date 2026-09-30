#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ $# -ne 3 ]]; then
  fail "usage: $0 <immutable-postgres-image-reference> <immutable-control-plane-image-reference> <public-hostname>"
fi

POSTGRES_IMAGE="$1"
CONTROL_PLANE_IMAGE="$2"
PUBLIC_HOSTNAME="$3"

for IMAGE in "${POSTGRES_IMAGE}" "${CONTROL_PLANE_IMAGE}"; do
  if [[ ! "${IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]]; then
    fail "image references must be pinned by a 64-character sha256 digest"
  fi
done

python3 - "${PUBLIC_HOSTNAME}" <<'PYHOST'
import ipaddress
import re
import sys

hostname = sys.argv[1]

if len(hostname) > 253:
    raise SystemExit("public hostname exceeds 253 characters")

if hostname != hostname.lower():
    raise SystemExit("public hostname must be lowercase")

if hostname.endswith("."):
    raise SystemExit("public hostname must not have a trailing dot")

if hostname.endswith(".invalid"):
    raise SystemExit(
        "public hostname must not use the reserved .invalid deployment sentinel"
    )

try:
    ipaddress.ip_address(hostname)
except ValueError:
    pass
else:
    raise SystemExit("public hostname must be a DNS name, not an IP address")

labels = hostname.split(".")

if len(labels) < 2:
    raise SystemExit("public hostname must contain at least two DNS labels")

label_pattern = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)

for label in labels:
    if not label_pattern.fullmatch(label):
        raise SystemExit(
            f"public hostname contains an invalid DNS label: {label!r}"
        )
PYHOST

SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd
)"

REPO_ROOT="$(
  cd -- "${SCRIPT_DIR}/../../.." &&
  pwd
)"

OVERLAY_REL="infra/kubernetes/overlays/aws"
RENDERED="$(mktemp)"

trap 'rm -f "${RENDERED}"' EXIT

if command -v kubectl >/dev/null 2>&1; then
  kubectl kustomize \
    "${REPO_ROOT}/${OVERLAY_REL}" \
    > "${RENDERED}"
elif command -v docker >/dev/null 2>&1; then
  docker run --rm \
    -v "${REPO_ROOT}:/work" \
    -w /work \
    registry.k8s.io/kubectl:v1.36.4 \
    kustomize "${OVERLAY_REL}" \
    > "${RENDERED}"
else
  fail "kubectl or docker is required to render the AWS overlay"
fi

python3 - \
  "${POSTGRES_IMAGE}" \
  "${CONTROL_PLANE_IMAGE}" \
  "${PUBLIC_HOSTNAME}" \
  "${RENDERED}" <<'PYRENDER'
import re
import sys
from pathlib import Path

postgres_image = sys.argv[1]
control_plane_image = sys.argv[2]
public_hostname = sys.argv[3]
rendered_path = Path(sys.argv[4])

text = rendered_path.read_text()

postgres_pattern = re.compile(
    r"registry\.invalid/gpulink/postgres-pgbackrest@"
    r"(sha256:[0-9a-f]{64})"
)

postgres_digests = postgres_pattern.findall(text)

if (
    len(postgres_digests) < 2
    or len(set(postgres_digests)) != 1
):
    raise SystemExit(
        "expected at least two identical registry.invalid PostgreSQL "
        f"image sentinels, found {len(postgres_digests)}"
    )

postgres_digest = postgres_digests[0]

if not postgres_image.endswith(
    "@" + postgres_digest
):
    raise SystemExit(
        "deployment PostgreSQL image digest does not match committed "
        f"accepted digest {postgres_digest}"
    )

postgres_placeholder = (
    "registry.invalid/gpulink/postgres-pgbackrest@"
    + postgres_digest
)

control_plane_pattern = re.compile(
    r"registry\.invalid/gpulink/control-plane@"
    r"(sha256:[0-9a-f]{64})"
)

control_plane_digests = control_plane_pattern.findall(text)

if (
    len(control_plane_digests) != 1
    or len(set(control_plane_digests)) != 1
):
    raise SystemExit(
        "expected exactly one committed registry.invalid control-plane "
        f"image sentinel, found {len(control_plane_digests)}"
    )

control_plane_digest = control_plane_digests[0]

if not control_plane_image.endswith(
    "@" + control_plane_digest
):
    raise SystemExit(
        "deployment control-plane image digest does not match committed "
        f"accepted digest {control_plane_digest}"
    )

control_plane_placeholder = (
    "registry.invalid/gpulink/control-plane@"
    + control_plane_digest
)

hostname_sentinel = "control-plane.gpulink.invalid"

hostname_sentinel_count = text.count(
    hostname_sentinel
)

if hostname_sentinel_count != 3:
    raise SystemExit(
        "expected exactly three committed control-plane hostname "
        f"sentinels, found {hostname_sentinel_count}"
    )

text = text.replace(
    postgres_placeholder,
    postgres_image,
)

text = text.replace(
    control_plane_placeholder,
    control_plane_image,
)

text = text.replace(
    hostname_sentinel,
    public_hostname,
)

if "registry.invalid/gpulink/" in text:
    raise SystemExit(
        "an unresolved GPULink image sentinel survived rendering"
    )

if hostname_sentinel in text:
    raise SystemExit(
        "the control-plane hostname sentinel survived rendering"
    )

if text.count(public_hostname) != 3:
    raise SystemExit(
        "rendered public hostname did not replace exactly three sentinels"
    )

sys.stdout.write(text)
PYRENDER
