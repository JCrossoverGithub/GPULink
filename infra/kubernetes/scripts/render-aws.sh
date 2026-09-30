#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  fail "usage: $0 <immutable-postgres-image-reference> <immutable-control-plane-image-reference>"
fi

POSTGRES_IMAGE="$1"
CONTROL_PLANE_IMAGE="$2"

for IMAGE in "${POSTGRES_IMAGE}" "${CONTROL_PLANE_IMAGE}"; do
  if [[ ! "${IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]]; then
    fail "image references must be pinned by a 64-character sha256 digest"
  fi
done

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
  "${RENDERED}" <<'PYRENDER'
import re
import sys
from pathlib import Path

postgres_image = sys.argv[1]
control_plane_image = sys.argv[2]
rendered_path = Path(sys.argv[3])

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

control_plane_placeholder = (
    "registry.invalid/gpulink/control-plane@"
    "sha256:"
    + ("0" * 64)
)

control_plane_count = text.count(
    control_plane_placeholder
)

if control_plane_count != 1:
    raise SystemExit(
        "expected exactly one fail-closed control-plane image "
        f"sentinel, found {control_plane_count}"
    )

text = text.replace(
    postgres_placeholder,
    postgres_image,
)

text = text.replace(
    control_plane_placeholder,
    control_plane_image,
)

if "registry.invalid/gpulink/" in text:
    raise SystemExit(
        "an unresolved GPULink image sentinel survived rendering"
    )

sys.stdout.write(text)
PYRENDER
