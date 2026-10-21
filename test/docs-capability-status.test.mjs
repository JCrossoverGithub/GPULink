import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');

// Read-only: no GPU, network, credentials, services, or external dependencies.
test('public README and role guide refer to the current capability contract', () => {
  const readme = read('README.md');
  const guide = read('docs/GETTING_STARTED.md');
  assert.match(readme, /\[Capability Status\]\(docs\/CAPABILITY_STATUS\.md\)/u);
  assert.match(guide, /\[capability status matrix\]\(CAPABILITY_STATUS\.md\)/u);
  assert.doesNotMatch(readme, /not yet\s+merged into `main`/u);
  assert.doesNotMatch(guide, /`4810e925` source checkpoint/u);
});

test('capability status has independently resolvable local evidence references', () => {
  const content = read('docs/CAPABILITY_STATUS.md');
  assert.match(content, /03cf54617aed71d4c4cd188ed68334a36443e545/u);
  const links = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((entry) => entry[1]);
  assert.ok(links.length >= 8);
  for (const link of links) {
    assert.doesNotMatch(link, /^(?:https?:|\/)/u);
    assert.ok(existsSync(path.resolve(root, 'docs', link)), `missing: ${link}`);
  }
});

test('source SDK publication flags agree with the documented pre-v1 boundary', () => {
  for (const name of ['gpulink-sdk', 'gpulink-adapter-sdk']) {
    const pkg = JSON.parse(read(`packages/${name}/package.json`));
    assert.equal(pkg.private, true, `${name} must not be described as public npm`);
  }
  const status = read('docs/CAPABILITY_STATUS.md');
  assert.match(status, /TypeScript Client SDK[^\n]+\*\*private\*\*/u);
  assert.match(status, /Adapter SDK[^\n]+\*\*private\*\*/u);
});

test('live GPU acceptance stays explicitly opted in and is not a CI step', () => {
  const gate = read('scripts/acceptance/installed-local-gpu-diagnostic.sh');
  const ci = read('.github/workflows/ci.yml');
  assert.match(gate, /GPULINK_E2E_DIAGNOSTIC_ACK/u);
  assert.doesNotMatch(ci, /scripts\/acceptance\/installed-local-gpu-diagnostic\.sh/u);
});
