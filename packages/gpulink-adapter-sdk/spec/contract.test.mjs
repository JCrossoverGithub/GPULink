import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {
  ADAPTER_SDK_COMPATIBILITY, AdapterCompatibilityError, assertAdapterCompatibility,
} from '../src/contract.mjs';
import {GLIP_V1, encodeGlipV1, decodeGlipV1} from '../src/echo-conformance.mjs';
import {packAdapter, inspectAdapter} from '../src/package-workflow.mjs';
import {mkdtemp, mkdir, copyFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

const c = ADAPTER_SDK_COMPATIBILITY;
const declaration = Object.freeze({
  protocol:'gpulink.adapter.ipc',ipcVersion:1,manifestSchemaVersion:2,
  packageSchemaVersion:1,executionMode:'streaming-gateway',completionMode:'explicit-text-v1',
});
const bad = code => e => e instanceof AdapterCompatibilityError && e.code===code;

test('SDK version declaration matches npm package; stable pre-v1 surface is immutable', async () => {
  const pkg=JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8'));
  assert.equal(c.sdkVersion,pkg.version);
  assert.equal(pkg.private,true,'pre-v1 SDK must not become public without release review');
  assert.equal(pkg.exports['./contract'],'./src/contract.mjs');
  assert.equal(c.stability,'experimental-pre-v1');
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.ipc) && Object.isFrozen(c.completionModes));
  assert.deepEqual(assertAdapterCompatibility(declaration),{compatible:true,sdkVersion:pkg.version});
});

test('version incompatibilities are bounded, distinct and never silently downgraded', () => {
  assert.throws(() => assertAdapterCompatibility({...declaration,ipcVersion:2}),bad('unsupported_ipc'));
  assert.throws(() => assertAdapterCompatibility({...declaration,manifestSchemaVersion:1}),bad('unsupported_manifest'));
  assert.throws(() => assertAdapterCompatibility({...declaration,packageSchemaVersion:2}),bad('unsupported_package'));
  assert.throws(() => assertAdapterCompatibility({...declaration,executionMode:'batch'}),bad('unsupported_execution_mode'));
  assert.throws(() => assertAdapterCompatibility({...declaration,completionMode:'implicit-exit'}),bad('unsupported_completion_mode'));
  assert.throws(() => assertAdapterCompatibility({...declaration,unexpected:true}),bad('invalid_declaration'));
  assert.throws(() => assertAdapterCompatibility(Object.create(null)),bad('invalid_declaration'));
});

test('declared GLIP and bundle versions agree with independent wire and package tooling', async t => {
  const bytes=encodeGlipV1(GLIP_V1.BINARY,Buffer.from([0,255]));
  assert.equal(bytes.subarray(0,4).toString('ascii'),'GLIP');
  assert.equal(decodeGlipV1(bytes)[0].kind,GLIP_V1.BINARY);
  const root=await mkdtemp(path.join(tmpdir(),'gpulink-contract-'));
  t.after(async()=>await rm(root,{recursive:true,force:true}));
  const author=path.join(root,'author'); const out=path.join(root,'bundle');
  await mkdir(author);
  await copyFile(fileURLToPath(new URL('../../../examples/external-adapter/echo-subprocess.py',import.meta.url)),path.join(author,'echo.py'));
  await writeFile(path.join(author,'gpulink.adapter.json'),JSON.stringify({
    schemaVersion:c.packageSchemaVersion,
    manifest:{schemaVersion:c.manifestSchemaVersion,type:'example.subprocess.echo',
      adapterId:'example.contract.echo.v1',version:'1.0.0',executionMode:c.executionMode},
    entry:'echo.py',completionMode:declaration.completionMode,
  }));
  const packed=await packAdapter({sourceDir:author,outDir:out});
  assert.equal(packed.lock.schemaVersion,c.packageSchemaVersion);
  assert.deepEqual((await inspectAdapter({bundleDir:out})).lock,packed.lock);
});
