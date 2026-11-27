#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
KIT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ $# == 2 ]] || { echo 'Usage: prepare.sh --registry|/absolute/verified/extracted /absolute/new-project' >&2; exit 2; }
MODE="$1"
OUT="$2"
[[ "$OUT" == /* && ! -e "$OUT" && ! -L "$OUT" ]]
[[ "$(node -p 'Number(process.versions.node.split(".")[0])>=24')" == true ]]
(cd "$KIT" && sha256sum -c SHA256SUMS)
if [[ "$MODE" != --registry ]]; then
REV=6220a093d5a70abd8d735df2d51163315dc67090
DIST="$(realpath -- "${1:?Provide extracted accepted distribution directory}")"
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
fi
mkdir -- "$OUT"
mkdir "$OUT/author-project" "$OUT/client-project"
for ROLE in author client; do
  cd "$OUT/$ROLE-project"
  printf '{"name":"vector-search-%s","version":"1.0.0","private":true,"type":"module"}\n' "$ROLE" > package.json
  if [[ "$ROLE" == author ]]; then PKG=gpulink-adapter-sdk-0.1.0.tgz; else PKG=gpulink-client-0.1.0.tgz; fi
  if [[ "$MODE" == --registry ]]; then
    if [[ "$ROLE" == author ]]; then NAME=@gpulink/adapter-sdk; else NAME=@gpulink/client; fi
    npm install --save-exact --ignore-scripts --registry=https://registry.npmjs.org/ "$NAME@0.1.0"
    node --input-type=module - "$NAME" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const name=process.argv[2];
const lock=JSON.parse(readFileSync('package-lock.json'));
const entry=lock.packages[`node_modules/${name}`];
const expected={
  '@gpulink/client':'sha512-e/5p2BK0CaARDKACIzyRv5IWyBsBfauJaVsRUYO2Enpt8XZdqUkIllnoiZgj3F8zizZb1BG3GuhAMQjIpUdqWA==',
  '@gpulink/adapter-sdk':'sha512-eTlWJF+5KbU3uJR0YOek/0p4980Le4Q/YG4qOcNJu81VvrUf056JwjR1GmeYSSmGUWDPz20n+Cl/bh0v/wmfIw==',
};
assert.equal(entry.version,'0.1.0');
assert.equal(entry.integrity,expected[name]);
assert.equal(new URL(entry.resolved).origin,'https://registry.npmjs.org');
console.log(`PASS: ${name} matches accepted public package integrity`);
JS
  else
    npm install --offline --ignore-scripts --no-audit --no-fund "$DIST/$PKG"
  fi
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
