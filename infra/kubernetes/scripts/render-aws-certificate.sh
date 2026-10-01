#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  fail "usage: $0 <public-hostname>"
fi

PUBLIC_HOSTNAME="$1"

python3 - "$PUBLIC_HOSTNAME" <<'PYHOST'
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

CERTIFICATE_SOURCE="$(
  cd -- "${SCRIPT_DIR}/.." &&
  pwd
)/overlays/aws/cert-manager/certificate.yaml"

if [[ ! -f "$CERTIFICATE_SOURCE" ]]; then
  fail "Certificate source not found: $CERTIFICATE_SOURCE"
fi

python3 - \
  "$PUBLIC_HOSTNAME" \
  "$CERTIFICATE_SOURCE" <<'PYRENDER'
from pathlib import Path
import sys

public_hostname = sys.argv[1]
source_path = Path(sys.argv[2])

sentinel = "control-plane.gpulink.invalid"

text = source_path.read_text(encoding="utf-8")

count = text.count(sentinel)

if count != 1:
    raise SystemExit(
        "expected exactly one committed Certificate hostname "
        f"sentinel, found {count}"
    )

rendered = text.replace(
    sentinel,
    public_hostname,
)

if sentinel in rendered:
    raise SystemExit(
        "Certificate hostname sentinel survived rendering"
    )

if rendered.count(public_hostname) != 1:
    raise SystemExit(
        "rendered hostname did not replace exactly one sentinel"
    )

sys.stdout.write(rendered)
PYRENDER
