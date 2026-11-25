#!/usr/bin/env node
// Install the actual candidate with an empty npm cache and no registry access.
// On Linux, explicitly exercise only an owned localhost control plane (no GPU worker).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

const npmCli = process.env.npm_execpath;
let scratch, env, cwd, attemptedStart = false, stopped = false;
function invoke(command, args, options, expected = 0) {
  const r = spawnSync(command, args, {encoding:'utf8', timeout:120_000, windowsHide:true, ...options});
  // Don't dump subprocess output or credential values on unexpected failures.
  if (r.error || r.status !== expected) throw new Error(`${args.join(' ')}: expected exit ${expected}, received ${r.status ?? r.error?.code ?? 'unknown'}`);
  return r.stdout;
}
function cli(args, expected = 0) {
  if (process.platform === 'win32') {
    // All arguments here are fixed, relative, shell-safe strings, never external inputs.
    if (!args.every(arg => /^[A-Za-z0-9_./-]+$/.test(arg))) throw new Error('Unsafe test argument');
    return invoke(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c', `gpulink ${args.join(' ')}`], {cwd, env, windowsVerbatimArguments:true}, expected);
  }
  return invoke('gpulink', args, {cwd, env}, expected);
}
const a = ['--config-dir', '../a'];
try {
  if (!npmCli || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Run with npm and Node.js 24+.');
  if (!['linux','win32'].includes(process.platform)) throw new Error('Candidate acceptance currently supports Linux and Windows only.');
  if (process.argv.length !== 3) throw new Error('Supply the candidate output directory.');
  const directory = path.resolve(process.argv[2]);
  const release = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
  assert.equal(release.package, '@gpulink/cli');
  assert.match(release.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  assert.equal(release.artifact, `gpulink-cli-${release.version}.tgz`);
  const tarball = path.join(directory, release.artifact);
  const bytes = readFileSync(tarball);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, release.sha256);
  assert.equal(bytes.length, release.bytes);
  assert.equal(readFileSync(path.join(directory,'SHA256SUMS'),'utf8'), `${digest}  ${release.artifact}\n`);
  console.log('PASS: candidate checksum and metadata');
  // Keep Linux Unix-domain socket path short; isolate HOME and npm cache.
  scratch = mkdtempSync(path.join(os.tmpdir(), 'gpl-'));
  const consumer = path.join(scratch,'consumer');
  const home = path.join(scratch,'home');
  const bin = process.platform === 'win32' ? consumer : path.join(consumer,'bin');
  cwd = path.join(scratch,'unrelated');
  for (const dir of [consumer,home,cwd,path.join(scratch,'other')]) mkdirSync(dir);
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GPULINK_|PATH$|HOME$|USERPROFILE$|NODE_PATH$|NODE_OPTIONS$|npm_config_)/i.test(k)));
  Object.assign(env, {PATH: `${bin}${path.delimiter}${process.env.PATH || process.env.Path}`, HOME:home, USERPROFILE:home,
    npm_config_cache:path.join(scratch,'empty-cache'), npm_config_userconfig:path.join(scratch,'empty-npmrc'), npm_config_globalconfig:path.join(scratch,'empty-global-npmrc')});
  invoke(process.execPath,[npmCli,'install','--global','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball], {cwd,env});
  assert.ok(existsSync(path.join(bin,process.platform === 'win32' ? 'gpulink.cmd' : 'gpulink')));
  assert.equal(cli(['--version']).trim(), release.version);
  assert.match(cli(['--help']), /gpulink.*config-dir/);
  console.log('PASS: installed artifact offline, direct gpulink invocation outside checkout');
  cli([...a,'init','local']);
  cli([...a,'doctor','control-plane']);
  cli([...a,'doctor','worker']);
  const original = readFileSync(path.join(scratch,'a','control-plane.env'),'utf8');
  cli([...a,'init','local'],1);
  assert.ok(readFileSync(path.join(scratch,'a','control-plane.env'),'utf8') === original, 'existing setup changed');
  cwd = path.join(scratch,'other');
  cli([...a,'doctor','control-plane']);
  cli(['--config-dir','../b','init','local']);
  const first = parseEnv(original);
  const second = parseEnv(readFileSync(path.join(scratch,'b','control-plane.env'),'utf8'));
  for (const key of ['GPULINK_CLIENT_TOKEN','GPULINK_WORKER_TOKEN','GPULINK_ADMIN_TOKEN','GPULINK_DATA_PLANE_SIGNING_KEY']) {
    assert.ok(first[key] && second[key] && first[key] !== second[key], 'installations must not share role credentials');
  }
  console.log('PASS: independent setups, doctors, CWD independence and non-overwrite');
  if (process.platform === 'linux') {
    // Do not start or adopt a service if the fixed local preview port is occupied.
    const before = JSON.parse(cli([...a,'local','status']));
    assert.equal(before.controlPlane,'offline');
    attemptedStart = true;
    cli([...a,'local','start']);
    assert.equal(JSON.parse(cli([...a,'local','status'])).controlPlane,'ready-managed-local');
    assert.deepEqual(JSON.parse(cli([...a,'jobs'])).jobs,[]);
    cli([...a,'local','stop']);
    assert.equal(JSON.parse(cli([...a,'local','status'])).controlPlane,'offline');
    stopped = true;
    console.log('PASS: installed Linux control plane start/status/empty jobs/stop (no worker or GPU work)');
  } else {
    cli([...a,'local','start'],1);
    console.log('PASS: Windows CLI install; unsupported managed lifecycle refused');
  }
  invoke(process.execPath,[npmCli,'uninstall','--global','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund','@gpulink/cli'],{cwd,env});
  assert.ok(!existsSync(path.join(bin,process.platform === 'win32' ? 'gpulink.cmd' : 'gpulink')));
  assert.ok(readFileSync(path.join(scratch,'a','control-plane.env'),'utf8') === original, 'uninstall must not delete instance data');
  console.log('PASS: uninstall removes executable and preserves independent configuration');
} catch (error) {
  console.error(`CLI release acceptance failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (attemptedStart && !stopped) {
    // Preserve the owned test directory if shutdown is uncertain. Never signal a PID from disk.
    try {
      cli([...a,'local','stop']);
      stopped = JSON.parse(cli([...a,'local','status'])).controlPlane === 'offline';
    } catch { /* preserve for investigation */ }
  }
  if (scratch && (!attemptedStart || stopped)) rmSync(scratch,{recursive:true,force:true});
  else if (scratch) {
    console.error(`Inspect disposable test directory before cleanup: ${scratch}`);
    process.exitCode = 1;
  }
}
