#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  fail "usage: $0 <immutable-postgres-image-reference>"
fi

IMAGE="$1"

if [[ "${IMAGE}" != *@sha256:* ]]; then
  fail "image reference must be pinned by sha256 digest"
fi

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
  kubectl kustomize "${REPO_ROOT}/${OVERLAY_REL}" > "${RENDERED}"
elif command -v docker >/dev/null 2>&1; then
  docker run --rm \
    -v "${REPO_ROOT}:/work" \
    -w /work \
    registry.k8s.io/kubectl:v1.36.4 \
    kustomize "${OVERLAY_REL}" > "${RENDERED}"
else
  fail "kubectl or docker is required to render the AWS overlay"
fi

python3 - "${IMAGE}" "${RENDERED}" <<'PYRENDER'
import re
import sys
from pathlib import Path

image = sys.argv[1]
rendered_path = Path(sys.argv[2])
text = rendered_path.read_text()

pattern = re.compile(
    r"registry\.invalid/gpulink/postgres-pgbackrest@"
    r"(sha256:[0-9a-f]{64})"
)

digests = pattern.findall(text)

if len(digests) < 2 or len(set(digests)) != 1:
    raise SystemExit(
        "expected at least two identical registry.invalid PostgreSQL image "
        f"sentinels, found {len(digests)}"
    )

digest = digests[0]

if not image.endswith("@" + digest):
    raise SystemExit(
        "deployment image digest does not match committed accepted digest "
        f"{digest}"
    )

placeholder = f"registry.invalid/gpulink/postgres-pgbackrest@{digest}"

sys.stdout.write(text.replace(placeholder, image))
PYRENDER
