/**
 * DP3 opt-in: npm-tarball-installed author tool -> portable adapter directory ->
 * operator-reviewed catalog candidate -> existing trusted loader. This does
 * NOT install/approve anything, nor prove transitive native dependency closure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, readFile, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadApprovedSubprocessSessionAdapters} from '../../src/worker/approved-subprocess-adapters.mjs';
import {runEchoConformance} from '../../packages/gpulink-adapter-sdk/src/echo-conformance.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const sdkDir=path.join(root,'packages/gpulink-adapter-sdk');
function run(executable,args,cwd,env={}) {
  const r=spawnSync(executable,args,{cwd,encoding:'utf8',timeout:30_000,maxBuffer:512_000,
    env:{...process.env,...env,npm_config_audit:'false',npm_config_fund:'false'}});
  assert.ifError(r.error);
  assert.equal(r.status,0,`exit ${r.status}: ${r.stderr.slice(-2000)} ${r.stdout.slice(-500)}`);
  return r.stdout;
}

test('independent npm SDK produces reviewed catalog accepted by unchanged operator loader',
  {timeout:60_000}, async t => {
  const tmp=await mkdtemp(path.join(tmpdir(),'gpulink-adapter-distribution-gate-'));
  t.after(async()=>{await rm(tmp,{recursive:true,force:true});});
  const consumer=path.join(tmp,'external-developer');
  const author=path.join(tmp,'adapter-src');
  const packDir=path.join(tmp,'tarballs');
  const bundle=path.join(tmp,'operator-controlled-bundle');
  await Promise.all([mkdir(consumer),mkdir(author),mkdir(packDir)]);
  const env={npm_config_cache:path.join(tmp,'npm-cache'),npm_config_offline:'true'};
  const packed=JSON.parse(run('npm',['pack','--offline','--ignore-scripts','--json',
    '--pack-destination',packDir],sdkDir,env));
  assert.equal(packed[0].name,'@gpulink/adapter-sdk');
  await writeFile(path.join(consumer,'package.json'),
    '{"name":"independent-adapter-developer","private":true,"type":"module"}\n');
  run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',
    path.join(packDir,packed[0].filename)],consumer,env);

  // This source is outside GPULink and imports no worker/Core modules.
  await copyFile(path.join(root,'examples/external-adapter/echo-subprocess.py'),path.join(author,'main.py'));
  await writeFile(path.join(author,'gpulink.adapter.json'), JSON.stringify({
    schemaVersion:1, manifest:{schemaVersion:2,type:'example.subprocess.echo',
      adapterId:'example.subprocess.echo.external.package.v1',version:'1.0.0',
      executionMode:'streaming-gateway'},
    entry:'main.py',completionMode:'explicit-text-v1',
  }));
  const cli=path.join(consumer,'node_modules/@gpulink/adapter-sdk/bin/package.mjs');
  assert.match(run(process.execPath,[cli,'pack','--source',author,'--out',bundle],consumer),/PASS: created portable package/u);
  assert.match(run(process.execPath,[cli,'inspect','--bundle',bundle],consumer),/PASS: bundle integrity/u);
  const python=realpathSync('/usr/bin/python3');
  const catalog=JSON.parse(run(process.execPath,[cli,'catalog','--bundle',bundle,
    '--interpreter',python],consumer));

  // Only the operator/harness writes their catalog, in a separate controlled
  // path. Packaging the bundle does not grant execution or install it.
  assert.equal((await loadApprovedSubprocessSessionAdapters(null)).length,0);
  const catalogPath=path.join(tmp,'operator-approved-catalog.json');
  await writeFile(catalogPath,JSON.stringify(catalog),{mode:0o600});
  let adapters=await loadApprovedSubprocessSessionAdapters(catalogPath);
  assert.equal(adapters.length,1);
  assert.equal(adapters[0].manifest.adapterId,'example.subprocess.echo.external.package.v1');
  assert.equal(await adapters[0].readinessProbe(),true);
  assert.equal(runEchoConformance({executable:python,
    args:['-I','-B',path.join(bundle,'main.py')]}).length,6);

  // Mutating a pinned artifact invalidates both SDK bundle integrity and
  // existing worker admission readiness. Revoke by removing the catalog entry.
  await writeFile(path.join(bundle,'main.py'),'# tampered\n');
  assert.equal(await adapters[0].readinessProbe(),false);
  await assert.rejects(loadApprovedSubprocessSessionAdapters(catalogPath),
    /approved_file_hash_mismatch/u);
  await writeFile(catalogPath,JSON.stringify({schemaVersion:1,adapters:[]}),{mode:0o600});
  adapters=await loadApprovedSubprocessSessionAdapters(catalogPath);
  assert.equal(adapters.length,0);
  console.log('PASS: packed SDK -> portable bundle -> operator catalog -> revoke');
});
