#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
KIT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REV=6220a093d5a70abd8d735df2d51163315dc67090
DIST="$(realpath -- "${1:?Provide extracted accepted distribution directory}")"
OUT="${2:?Provide new project directory}"
[[ "$OUT" == /* ]]
[[ "$(node -p 'Number(process.versions.node.split(".")[0])>=24')" == true ]]
python3 -I - "$DIST" "$REV" <<'PY'
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]); rev=sys.argv[2]
m=json.loads((p/'candidate.json').read_text())
assert m['sourceRevision']==rev, 'wrong release revision'
files={'cli/gpulink-cli-0.1.0.tgz','cli/release.json','cli/SHA256SUMS','gpulink-client-0.1.0.tgz','gpulink-adapter-sdk-0.1.0.tgz','GPULink.Client.0.1.0-preview.1.nupkg'}
assert set(m['files'])==files
for name in files:
    data=(p/name).read_bytes(); record=m['files'][name]
    assert hashlib.sha256(data).hexdigest()==record['sha256'] and len(data)==record['bytes'], name
expected=''.join(f'{hashlib.sha256((p/n).read_bytes()).hexdigest()}  {n}\n' for n in sorted(files|{'candidate.json'}))
assert (p/'SHA256SUMS').read_text()==expected
print('PASS: accepted distribution revision and package bytes verified')
PY
mkdir -- "$OUT"
mkdir "$OUT/author-project" "$OUT/client-project"
for ROLE in author client; do
  cd "$OUT/$ROLE-project"
  printf '{"name":"vector-search-%s","version":"1.0.0","private":true,"type":"module"}\n' "$ROLE" > package.json
  if [[ "$ROLE" == author ]]; then PKG=gpulink-adapter-sdk-0.1.0.tgz; else PKG=gpulink-client-0.1.0.tgz; fi
  npm install --offline --ignore-scripts --no-audit --no-fund "$DIST/$PKG"
done
cd "$OUT/author-project"
TOOL=./node_modules/.bin/gpulink-adapter-package
"$TOOL" init-batch --out "$PWD/author" --type external.batch.vector-search
python3 -I - "$KIT/workload-function.py" "$PWD/author/workload.py" <<'PY'
import sys
from pathlib import Path
fn,starter=map(Path,sys.argv[1:]); code=starter.read_text()
start=code.index('def run(payload):\n'); end=code.index('\ndef reject_constant',start)
assert 'return {"echo": payload, "backend": "cpu-starter"}' in code[start:end]
starter.write_text(code[:start]+fn.read_text().rstrip()+'\n\n'+code[end:])
PY
"$TOOL" pack --source "$PWD/author" --out "$PWD/bundle"
"$TOOL" inspect --bundle "$PWD/bundle"
cd "$OUT/client-project"
cp "$KIT/"{search.mjs,reference.mjs,sample.json,test.mjs} .
node --test test.mjs
node search.mjs expected sample.json
printf 'PASS: independent author and client prepared at %s; no services started or workload approved.\n' "$OUT"
