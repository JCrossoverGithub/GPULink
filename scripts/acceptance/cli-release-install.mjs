#!/usr/bin/env node
// Install the actual candidate with an empty npm cache and no registry access.
// On Linux, explicitly exercise only an owned localhost control plane (no GPU worker).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const npmCli = process.env.npm_execpath;
let scratch, env, cwd, attemptedStart = false, stopped = false, serverAttempted = false, serverStopped = false, proxy;
function invoke(command, args, options, expected = 0) {
  const r = spawnSync(command, args, {encoding:'utf8', timeout:120_000, windowsHide:true, ...options});
  // Don't dump subprocess output or credential values on unexpected failures.
  if (r.error || r.status !== expected) throw new Error(`${args.join(' ')}: expected exit ${expected}, received ${r.status ?? r.error?.code ?? 'unknown'}`);
  return r.stdout;
}
function cli(args, expected = 0) {
  if (process.platform === 'win32') {
    // All arguments here are fixed, relative, shell-safe strings, never external inputs.
    if (!args.every(arg => /^[A-Za-z0-9_./:-]+$/.test(arg))) throw new Error('Unsafe test argument');
    return invoke(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c', `gpulink ${args.join(' ')}`], {cwd, env, windowsVerbatimArguments:true}, expected);
  }
  return invoke('gpulink', args, {cwd, env}, expected);
}
const a = ['--config-dir', '../a'];
const server = ['--config-dir', '../s'];
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
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GPULINK_|PATH$|HOME$|USERPROFILE$|NODE_PATH$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_USE_SYSTEM_CA$|npm_config_)/i.test(k)));
  Object.assign(env, {PATH: `${bin}${path.delimiter}${process.env.PATH || process.env.Path}`, HOME:home, USERPROFILE:home,
    npm_config_cache:path.join(scratch,'empty-cache'), npm_config_userconfig:path.join(scratch,'empty-npmrc'), npm_config_globalconfig:path.join(scratch,'empty-global-npmrc')});
  invoke(process.execPath,[npmCli,'install','--global','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball], {cwd,env});
  assert.ok(existsSync(path.join(bin,process.platform === 'win32' ? 'gpulink.cmd' : 'gpulink')));
  assert.equal(cli(['--version']).trim(), release.version);
  const help = cli(['--help']);
  assert.match(help, /gpulink.*config-dir/);
  assert.match(help, /setup server --peer PRIVATE_IPV4/);
  assert.match(help, /join --invite FILE/);
  cli(['join'],2);
  cli(['setup','server'],1);
  console.log('PASS: installed managed onboarding entry points; incomplete commands refused without provisioning');
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
    // A temporary certificate and proxy exercise real HTTPS to the actual installed
    // backend, not the public Internet or any operator-owned TLS infrastructure.
    const key = path.join(scratch,'test-key.pem');
    const cert = path.join(scratch,'test-cert.pem');
    invoke('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{cwd,env});
    proxy = spawn(process.execPath,['-e',`
      const fs = require('node:fs'), https = require('node:https'), http = require('node:http');
      const server = https.createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])}, (req,res) => {
        const upstream = http.request({hostname:'127.0.0.1',port:8088,path:req.url,method:req.method,headers:req.headers}, reply => {
          res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
        });
        upstream.on('error',()=>{res.writeHead(502);res.end();}); req.pipe(upstream);
      });
      server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
    `,key,cert],{cwd,env,stdio:['ignore','pipe','ignore']});
    const proxyPort = await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(new Error('Test TLS proxy startup timed out')),5000);
      proxy.once('error',()=>{clearTimeout(timer);reject(new Error('Test TLS proxy failed'));});
      proxy.once('exit',()=>{clearTimeout(timer);reject(new Error('Test TLS proxy exited'));});
      let buffer=''; proxy.stdout.on('data',chunk=>{buffer+=chunk; if(buffer.includes('\n')){clearTimeout(timer);resolve(Number(buffer.trim()));}});
    });
    assert.ok(Number.isSafeInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536);
    const origin = `https://127.0.0.1:${proxyPort}`;
    cli([...server,'init','server','--public-url',origin]);
    cli([...server,'doctor','server']);
    cli([...server,'local','worker','start','--accept-assigned-work'],1);
    assert.equal(JSON.parse(cli([...server,'server','status'])).controlPlane,'offline');
    cli([...server,'jobs'],1);
    serverAttempted = true;
    cli([...server,'server','start']);
    assert.equal(JSON.parse(cli([...server,'server','status'])).controlPlane,'ready-managed-local');
    cli([...server,'server','start'],1);
    assert.deepEqual(JSON.parse(cli([...server,'jobs'])).jobs,[]);
    // Explicit TLS enforcement must reject an untrusted certificate even with
    // the insecure global Node setting. Never use that setting in deployment.
    env.NODE_TLS_REJECT_UNAUTHORIZED='0';
    cli([...server,'doctor','server','--live'],1);
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    env.NODE_EXTRA_CA_CERTS=cert;
    assert.match(cli([...server,'doctor','server','--live']),/PASS: verified HTTPS/);
    // Separate client invocation, using only the client-role credential via
    // the actual TLS proxy. No request submits a job or starts a worker.
    const control = parseEnv(readFileSync(path.join(scratch,'s','control-plane.env'),'utf8'));
    env.GPULINK_URL=origin;
    env.GPULINK_CLIENT_TOKEN=control.GPULINK_CLIENT_TOKEN;
    assert.deepEqual(JSON.parse(cli(['jobs'])).jobs,[]);
    env.GPULINK_CLIENT_TOKEN='invalid-test-token-not-a-real-secret';
    cli(['jobs'],1);
    delete env.GPULINK_URL; delete env.GPULINK_CLIENT_TOKEN;
    // DEV-03: use the actual installed CLI and server, not a simulated token
    // service. No worker starts; no GPU is required in unattended CI.
    const bundle = path.join(scratch,'s','worker-bundle.json');
    cli([...server,'server','worker-bundle','--output',bundle]);
    assert.equal(statSync(bundle).mode & 0o777,0o600);
    const grant = JSON.parse(readFileSync(bundle,'utf8'));
    assert.deepEqual(Object.keys(grant).sort(),['publicOrigin','schemaVersion','workerToken']);
    if(grant.workerToken !== control.GPULINK_WORKER_TOKEN) throw new Error('Exported wrong credential role');
    const w = ['--config-dir','../w'];
    const untrusted = ['--config-dir','../untrusted'];
    cli([...untrusted,'worker','enroll','--bundle',bundle]);
    env.NODE_TLS_REJECT_UNAUTHORIZED='0';
    cli([...untrusted,'worker','doctor','--live'],1);
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    cli([...w,'worker','enroll','--bundle',bundle,'--ca-file',cert]);
    cli([...w,'worker','doctor']);
    assert.match(cli([...w,'worker','doctor','--live']),/PASS: trusted HTTPS and worker-role authorization/);
    assert.equal(JSON.parse(cli([...w,'worker','status'])).managedState,'not-running');
    cli([...w,'worker','start'],2);
    cli([...w,'worker','enroll','--bundle',bundle],1);
    cli([...w,'local','start'],1);
    const wrong = path.join(scratch,'s','wrong-bundle.json');
    writeFileSync(wrong,JSON.stringify({...grant,workerToken:'0'.repeat(64)}),{mode:0o600,flag:'wx'});
    const bad = ['--config-dir','../bad'];
    cli([...bad,'worker','enroll','--bundle',wrong,'--ca-file',cert]);
    cli([...bad,'worker','doctor','--live'],1);
    assert.deepEqual(JSON.parse(cli([...server,'workers'])).workers,[]);
    console.log('PASS: installed worker bundle/enrollment, role-only credentials, private CA trust, invalid TLS/auth rejection, no registration or GPU execution');
    cli([...server,'server','stop']);
    assert.equal(JSON.parse(cli([...server,'server','status'])).controlPlane,'offline');
    serverStopped = true;
    cli([...server,'doctor','server','--live'],1);
    delete env.NODE_EXTRA_CA_CERTS;
    console.log('PASS: installed server lifecycle, real trusted HTTPS proxy, untrusted TLS and invalid client auth rejection, authenticated empty jobs, stopped backend');
  } else {
    cli([...a,'local','start'],1);
    cli([...server,'init','server','--public-url','https://gpu.example.org'],1);
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
  if (serverAttempted && !serverStopped) {
    try { cli([...server,'server','stop']); serverStopped = JSON.parse(cli([...server,'server','status'])).controlPlane === 'offline'; } catch { /* preserve for investigation */ }
  }
  if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
    const closed = once(proxy,'exit').catch(()=>{}); proxy.kill(); await Promise.race([closed,delay(2000)]);
  }
  if (attemptedStart && !stopped) {
    // Preserve the owned test directory if shutdown is uncertain. Never signal a PID from disk.
    try {
      cli([...a,'local','stop']);
      stopped = JSON.parse(cli([...a,'local','status'])).controlPlane === 'offline';
    } catch { /* preserve for investigation */ }
  }
  if (scratch && (!attemptedStart || stopped) && (!serverAttempted || serverStopped)) rmSync(scratch,{recursive:true,force:true});
  else if (scratch) {
    console.error(`Inspect disposable test directory before cleanup: ${scratch}`);
    process.exitCode = 1;
  }
}
