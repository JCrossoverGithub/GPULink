#!/usr/bin/env bash
# Explicit public-registry documentation acceptance; no GPU or deployment.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$(uname -s)" == Linux ]]
[[ "$(node -p 'Number(process.versions.node.split(".")[0])>=24')" == true ]]
for bin in npm python3 bash sha256sum; do command -v "$bin" >/dev/null; done
WORK="$(mktemp -d /tmp/gpulink-public-docs.XXXXXXXX)"
mkdir "$WORK/home" "$WORK/prefix" "$WORK/app"
touch "$WORK/user.npmrc" "$WORK/global.npmrc"
trap 'echo "Test files retained in $WORK"' EXIT
clean() {
  env -i PATH="$PATH" HOME="$WORK/home" \
    npm_config_cache="$WORK/cache" npm_config_userconfig="$WORK/user.npmrc" \
    npm_config_globalconfig="$WORK/global.npmrc" "$@"
}
cd "$WORK/app"
clean npm init -y >/dev/null
clean npm install --save-exact --ignore-scripts --registry=https://registry.npmjs.org/ @gpulink/client@0.1.0 @gpulink/adapter-sdk@0.1.0
# Check exact accepted package integrities, not just names or version strings.
clean node --input-type=module <<'JS'
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const pkgs=JSON.parse(readFileSync('package-lock.json')).packages;
for(const [name,integrity] of Object.entries({
 '@gpulink/client':'sha512-e/5p2BK0CaARDKACIzyRv5IWyBsBfauJaVsRUYO2Enpt8XZdqUkIllnoiZgj3F8zizZb1BG3GuhAMQjIpUdqWA==',
 '@gpulink/adapter-sdk':'sha512-eTlWJF+5KbU3uJR0YOek/0p4980Le4Q/YG4qOcNJu81VvrUf056JwjR1GmeYSSmGUWDPz20n+Cl/bh0v/wmfIw==',
})){
 const pkg=pkgs[`node_modules/${name}`];assert.equal(pkg.version,'0.1.0');assert.equal(pkg.integrity,integrity);assert.equal(new URL(pkg.resolved).origin,'https://registry.npmjs.org');
}
console.log('PASS: public SDK release integrity');
JS
REVIEW_PYTHON="${PYTHON:-/usr/bin/python3}"
[[ "$REVIEW_PYTHON" == /* && -x "$REVIEW_PYTHON" ]] || { echo "Set PYTHON to an absolute, trusted interpreter path." >&2; exit 1; }
clean env PYTHON="$REVIEW_PYTHON" node "$ROOT/scripts/acceptance/public-docs-examples.mjs" "$WORK/app"
clean bash "$ROOT/examples/vector-search/prepare.sh" --registry "$WORK/vector-search"
clean npm install -g --prefix "$WORK/prefix" --ignore-scripts --registry=https://registry.npmjs.org/ @gpulink/cli@0.1.0
CLI="$WORK/prefix/bin/gpulink"
[[ "$(clean "$CLI" --version)" == 0.1.0 ]]
clean "$CLI" --help
clean "$CLI" --config-dir "$WORK/setup" init local
clean "$CLI" --config-dir "$WORK/setup" doctor control-plane
clean "$CLI" --config-dir "$WORK/setup" doctor worker
clean npm uninstall -g --prefix "$WORK/prefix" --ignore-scripts @gpulink/cli
[[ ! -e "$CLI" && -f "$WORK/setup/client.env" ]]
echo 'PASS: public documentation registry acceptance (no physical GPU execution)'
