import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initBatchAdapter, preparePythonCatalog, packAdapter, inspectAdapter, operatorCatalogCandidate} from '../packages/gpulink-adapter-sdk/src/package-workflow.mjs';
import {loadApprovedSubprocessAdapters} from '../src/worker/approved-subprocess-adapters.mjs';
const cli = fileURLToPath(new URL('../packages/gpulink-adapter-sdk/bin/package.mjs', import.meta.url));
const type = 'external.batch.newcomer';
const uuid = 'GPU-326a4232-3d30-423b-29a1-66f2d054a0d4';
const sha = data => createHash('sha256').update(data).digest('hex');
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(),'gpulink-author-'));
  t.after(()=>rm(root,{recursive:true,force:true})); return root;
}
function invoke(root,...args) {return spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',timeout:5000});}
const py = spawnSync(process.platform === 'win32' ? 'python' : existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3', ['-c','import os,sys;print(os.path.realpath(sys.executable))'],{encoding:'utf8',timeout:3000});
const python = py.status === 0 ? realpathSync(py.stdout.trim()) : null;
const job = {id:'job_author_preview',type,assignedGpuUuid:uuid,payload:{message:'hello'}};
const context = () => ({signal:new AbortController().signal,gpu:{uuid}});

test('batch author CLI scaffolds a valid relocatable package without overwriting or executing',async t=>{
  const root=await temp(t);
  const out=invoke(root,'init-batch','--out','author','--type',type);
  assert.equal(out.status,0,out.stderr);
  const author=path.join(root,'author'), bundleDir=path.join(root,'bundle');
  const before=await readFile(path.join(author,'workload.py'));
  assert.notEqual(invoke(root,'init-batch','--out','author','--type',type).status,0);
  assert.deepEqual(await readFile(path.join(author,'workload.py')),before);
  assert.notEqual(invoke(root,'init-batch','--out','invalid','--type','diagnostic.echo').status,0);
  assert.notEqual(invoke(root,'init-batch','--out','invalid','--type',type,'--unknown','x').status,0);
  assert.deepEqual((await readdir(root)).sort(),['author']);
  const packed=await packAdapter({sourceDir:author,outDir:bundleDir});
  assert.equal(packed.lock.manifest.adapterId,`${type}.v1`);
  assert.equal(packed.lock.manifest.executionMode,'bounded-process');
  assert.equal(packed.lock.sha256,sha(before));
  assert.deepEqual((await inspectAdapter({bundleDir})).lock,packed.lock);
});

test('generated batch starter runs under existing worker contract, no GPU claim', {skip:!python},async t=>{
  const root=await temp(t), sourceDir=path.join(root,'author'),bundleDir=path.join(root,'bundle');
  await initBatchAdapter({outDir:sourceDir,type});
  await packAdapter({sourceDir,outDir:bundleDir});
  const catalog=await operatorCatalogCandidate({bundleDir,interpreter:python});
  const file=path.join(root,'catalog.json');
  await writeFile(file,JSON.stringify(catalog),{mode:0o600});
  const [adapter]=await loadApprovedSubprocessAdapters(file);
  assert.deepEqual(await adapter.executeJob(job,context()),{echo:job.payload,backend:'cpu-starter'});
});

test('Linux review preparation preserves virtualenv path with shell metacharacters; existing loader verifies generated files', {skip:process.platform!=='linux'||!python},async t=>{
  const root=await temp(t), sourceDir=path.join(root,'author'),bundleDir=path.join(root,'bundle');
  await initBatchAdapter({outDir:sourceDir,type});
  const file=path.join(sourceDir,'workload.py');
  const original=await readFile(file,'utf8');
  const anchor='return {"echo": payload, "backend": "cpu-starter"}';
  assert.equal(original.split(anchor).length,2);
  await writeFile(file,original.replace(anchor,'return {"prefix": sys.prefix, "echo": payload}'));
  await packAdapter({sourceDir,outDir:bundleDir});
  const venv=path.join(root,"venv ' $(touch NEVER_EXECUTE)");
  await mkdir(venv); await mkdir(path.join(venv,'bin'));
  await writeFile(path.join(venv,'pyvenv.cfg'),`home = ${path.dirname(python)}\ninclude-system-site-packages = false\n`);
  const interpreter=path.join(venv,'bin','python');
  await symlink(python,interpreter);
  const libraryPath=path.join(root,'lib directory'); await mkdir(libraryPath);
  const outDir=path.join(root,'review');
  const result=invoke(root,'prepare-python','--bundle','bundle','--interpreter',interpreter,'--out','review','--library-path',libraryPath);
  assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(result.stdout);
  assert.equal(r.catalogPath,path.join(outDir,'catalog.json'));
  assert.equal(r.sha256,sha(await readFile(r.catalogPath)));
  const [adapter]=await loadApprovedSubprocessAdapters(r.catalogPath);
  assert.equal(await adapter.readinessProbe(),true);
  assert.deepEqual(await adapter.executeJob(job,context()),{prefix:venv,echo:job.payload});
  assert.ok(!(await readdir(root)).includes('NEVER_EXECUTE'));
  await assert.rejects(preparePythonCatalog({bundleDir,interpreter,outDir}),{code:'output_must_not_exist'});
  await assert.rejects(preparePythonCatalog({bundleDir,interpreter,outDir:path.join(bundleDir,'review')}),{code:'output_inside_bundle'});
  await assert.rejects(preparePythonCatalog({bundleDir,interpreter:path.join(root,'missing'),outDir:path.join(root,'missing-review')}),{code:'interpreter_unavailable'});
  await writeFile(r.launcherPath,'tampered');
  assert.equal(await adapter.readinessProbe(),false);
  await assert.rejects(loadApprovedSubprocessAdapters(r.catalogPath),{code:'approved_file_hash_mismatch'});
});
