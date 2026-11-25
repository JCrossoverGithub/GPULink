#!/usr/bin/env node
// Verify the actual SDK archives outside the repository. No worker or GPU execution.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3 || !process.env.npm_execpath) throw new Error('Run npm run test:sdk:release -- <verified-candidate-directory>.');
const candidate = path.resolve(directory);
const manifest = JSON.parse(readFileSync(path.join(candidate,'candidate.json'),'utf8'));
const scratch = mkdtempSync(path.join(os.tmpdir(),'gpl-sdk-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GPULINK_|NODE_PATH$|NODE_OPTIONS$|npm_config_)/i.test(k)));
Object.assign(env, {npm_config_cache:path.join(scratch,'empty-cache'),npm_config_userconfig:path.join(scratch,'empty-npmrc'),npm_config_globalconfig:path.join(scratch,'empty-global-npmrc')});
function run(args) {
  const result = spawnSync(process.execPath,args,{cwd:scratch,env,stdio:'inherit',timeout:120_000,windowsHide:true});
  assert.equal(result.status,0,`Independent SDK command failed: ${args[0]}`);
}
try {
  writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'independent-release-consumer',private:true,type:'module'}));
  const artifacts = ['@gpulink/client','@gpulink/adapter-sdk'].map(name=> {
    const entry = manifest.packages.find(p=>p.name===name);
    assert.ok(entry && /^gpulink-(?:client|adapter-sdk)-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.test(entry.artifact));
    return path.join(candidate,entry.artifact);
  });
  run([process.env.npm_execpath,'install','--offline','--ignore-scripts','--no-audit','--no-fund',...artifacts]);
  const spec = readFileSync(path.join(root,'packages/gpulink-sdk/spec/job-wait.mjs'),'utf8');
  assert.equal(spec.split("'../dist/index.js'").length,2);
  writeFileSync(path.join(scratch,'installed-job-wait.mjs'),spec.replace("'../dist/index.js'","'@gpulink/client'"));
  run(['--test','installed-job-wait.mjs']);
  const bin = path.join(scratch,'node_modules/@gpulink/adapter-sdk/bin/package.mjs');
  assert.ok(existsSync(path.join(scratch,'node_modules/.bin',process.platform==='win32'?'gpulink-adapter-package.cmd':'gpulink-adapter-package')));
  run([bin,'init-batch','--out','author','--type','external.batch.release']);
  run([bin,'pack','--source',path.join(scratch,'author'),'--out',path.join(scratch,'bundle')]);
  run([bin,'inspect','--bundle',path.join(scratch,'bundle')]);
  console.log('PASS: exact candidate npm SDKs installed offline; durable wait and adapter packaging exercised.');
} finally { rmSync(scratch,{recursive:true,force:true}); }
