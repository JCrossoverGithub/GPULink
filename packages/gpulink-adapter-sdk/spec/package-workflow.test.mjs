import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  packAdapter, inspectAdapter, operatorCatalogCandidate, AdapterPackageError,
} from '../src/package-workflow.mjs';
import {runEchoConformance} from '../src/echo-conformance.mjs';

const fixture = fileURLToPath(new URL('../../../examples/external-adapter/echo-subprocess.py', import.meta.url));
const cli = fileURLToPath(new URL('../bin/package.mjs', import.meta.url));
const spec = {schemaVersion:1,
  manifest:{schemaVersion:2,type:'example.subprocess.echo',
    adapterId:'example.subprocess.echo.v1',version:'1.0.0',executionMode:'streaming-gateway'},
  entry:'echo.py',completionMode:'explicit-text-v1'};
async function author(root) {
  const directory=path.join(root,'author');
  await mkdir(directory);
  await copyFile(fixture,path.join(directory,'echo.py'));
  await writeFile(path.join(directory,'gpulink.adapter.json'), JSON.stringify(spec));
  return directory;
}
async function temp(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'gpulink-adapter-package-'));
  t.after(async()=>{await rm(dir,{recursive:true,force:true});});
  return dir;
}
const fails = (code) => e => e instanceof AdapterPackageError && e.code === code;

function findPython() {
  const probe = 'import os,sys;print(os.path.realpath(sys.executable))';
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['/usr/bin/python3', 'python3', 'python'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', probe], {
      encoding: 'utf8', timeout: 2_000, windowsHide: true,
    });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) {
      return realpathSync(result.stdout.trim());
    }
  }
  return null;
}
const pythonExecutable = findPython();

test('offline directory package is reproducible and independent of Core imports',
  {skip: !pythonExecutable && 'Requires a local Python interpreter'}, async t => {
  const root=await temp(t);
  const sourceDir=await author(root);
  const a=await packAdapter({sourceDir,outDir:path.join(root,'bundle-a')});
  const b=await packAdapter({sourceDir,outDir:path.join(root,'bundle-b')});
  assert.deepEqual(a.lock,b.lock);
  assert.deepEqual(await readFile(path.join(root,'bundle-a','gpulink.adapter.lock.json')),
    await readFile(path.join(root,'bundle-b','gpulink.adapter.lock.json')));
  assert.equal(a.lock.manifest.adapterId,'example.subprocess.echo.v1');
  assert.equal(runEchoConformance({executable:pythonExecutable,
    args:['-I','-B',a.programPath]}).length,6);
  await assert.rejects(packAdapter({sourceDir,outDir:path.join(root,'bundle-a')}),fails('output_must_not_exist'));
});

test('lock verification rejects mutation, unlisted file and renamed entry', async t => {
  const root=await temp(t);
  const bundleDir=path.join(root,'bundle');
  await packAdapter({sourceDir:await author(root),outDir:bundleDir});
  await writeFile(path.join(bundleDir,'unknown.txt'),'not approved');
  await assert.rejects(inspectAdapter({bundleDir}),fails('unexpected_bundle_files'));
  await rm(path.join(bundleDir,'unknown.txt'));
  await writeFile(path.join(bundleDir,'echo.py'),'tampered');
  await assert.rejects(inspectAdapter({bundleDir}),fails('artifact_digest_mismatch'));
  // Even rewriting the lock to a traversal path is rejected.
  const lockPath=path.join(bundleDir,'gpulink.adapter.lock.json');
  const lock=JSON.parse(await readFile(lockPath,'utf8'));
  lock.entry='../outside.py';
  await writeFile(lockPath,JSON.stringify(lock));
  await assert.rejects(inspectAdapter({bundleDir}),fails('invalid_entry_name'));
});

test('untrusted author recipe schema and symlinked sources fail closed', async t => {
  const root=await temp(t);
  const dir=await author(root);
  const recipe=path.join(dir,'gpulink.adapter.json');
  await writeFile(recipe,JSON.stringify({...spec,unknown:true}));
  await assert.rejects(packAdapter({sourceDir:dir,outDir:path.join(root,'bad')}),fails('invalid_package_descriptor'));
  await writeFile(recipe,JSON.stringify(spec));
  await rm(path.join(dir,'echo.py'));
  await symlink(fixture,path.join(dir,'echo.py'));
  await assert.rejects(packAdapter({sourceDir:dir,outDir:path.join(root,'link')}),fails('invalid_file_type_or_size'));
});

test('CLI reports integrity, emits existing trusted catalog schema and never activates it',
  {skip: !pythonExecutable && 'Requires a local Python interpreter'}, async t => {
  const root=await temp(t);
  const dir=await author(root);
  const bundleDir=path.join(root,'bundle');
  const packed=spawnSync(process.execPath,[cli,'pack','--source',dir,'--out',bundleDir],{encoding:'utf8'});
  assert.equal(packed.status,0,packed.stderr);
  const scanned=spawnSync(process.execPath,[cli,'inspect','--bundle',bundleDir],{encoding:'utf8'});
  assert.equal(scanned.status,0,scanned.stderr);
  const interpreter=pythonExecutable;
  const output=spawnSync(process.execPath,
    [cli,'catalog','--bundle',bundleDir,'--interpreter',interpreter],{encoding:'utf8'});
  assert.equal(output.status,0,output.stderr);
  const generated=JSON.parse(output.stdout);
  assert.deepEqual(generated,await operatorCatalogCandidate({bundleDir,interpreter}));
  assert.equal(generated.schemaVersion,1);
  assert.equal(generated.adapters[0].manifest.schemaVersion,2);
  assert.deepEqual(generated.adapters[0].command.args,['-I','-B',path.join(bundleDir,'echo.py')]);
  assert.equal(generated.adapters[0].command.assets[0].sha256,
    (await inspectAdapter({bundleDir})).lock.sha256);
  const wrong=spawnSync(process.execPath,[cli,'catalog','--bundle',bundleDir],{encoding:'utf8'});
  assert.notEqual(wrong.status,0);
  assert.ok(!output.stdout.includes('GPULINK_CLIENT_TOKEN'));
});
