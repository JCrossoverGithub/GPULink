/**
 * Opt-in DP3 developer integration gate (run explicitly; not a root unit test).
 * Operator-trusted Python echo with fake GPU + separately installed public Client
 * SDK application. The harness alone uses GPULink Core and worker internals.
 * NO real GPU, production worker, deployment, or untrusted-code isolation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {mkdtemp, mkdir, copyFile, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createControlPlane} from '../../src/control-plane/app.mjs';
import {WorkerAgent} from '../../src/worker/agent.mjs';
import {loadApprovedSubprocessSessionAdapters} from '../../src/worker/approved-subprocess-adapters.mjs';
import {runEchoConformance} from '../../packages/gpulink-adapter-sdk/src/echo-conformance.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sdkDir = path.join(root, 'packages/gpulink-sdk');
const TOKENS = Object.freeze({
  client:'dp3-external-client-test-token-at-least-32-characters',
  worker:'dp3-external-worker-test-token-at-least-32-characters',
  admin:'dp3-external-admin-test-token-at-least-32-characters',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd, encoding:'utf8', timeout:20_000, maxBuffer:512_000,
    env:{...process.env, npm_config_audit:'false', npm_config_fund:'false'},
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0,
    `command failed: ${args.join(' ')}: ${String(result.stderr).slice(-1500)}`);
  return result.stdout;
}
async function runConsumer(file, cwd, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd, env:{...process.env, ...env}, stdio:['ignore','pipe','pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 16_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => {stdout = (stdout + s).slice(-8000);});
    child.stderr.on('data', s => {stderr = (stderr + s).slice(-8000);});
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`external client exit ${code}: ${stderr} ${stdout}`));
      else resolve(stdout);
    });
  });
}

test('packed Client SDK reaches operator-approved external Python adapter through unchanged Core',
  {timeout:60_000}, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'gpulink-public-interfaces-e2e-'));
  let app;
  let agent;
  try {
    const packDir = path.join(tmp, 'pack');
    const consumerDir = path.join(tmp, 'consumer');
    const authorDir = path.join(tmp, 'adapter-author');
    await Promise.all([mkdir(packDir), mkdir(consumerDir), mkdir(authorDir)]);

    // Both app and adapter are copied outside the repository before execution.
    const clientApp = path.join(consumerDir, 'consumer.mjs');
    await copyFile(path.join(root, 'examples/gpulink-sdk/operator-approved-echo-client.mjs'), clientApp);
    const source = await readFile(path.join(root, 'examples/external-adapter/echo-subprocess.py'));
    const adapterFile = path.join(authorDir, 'echo.py');
    await writeFile(adapterFile, source, {mode:0o600});

    const pythonProbe = command('python3', ['-c', 'import sys; print(sys.executable)'], tmp).trim();
    const executable = realpathSync(existsSync('/usr/bin/python3') ? '/usr/bin/python3' : pythonProbe);
    const passed = runEchoConformance({executable, args:['-I', '-B', adapterFile]});
    assert.equal(passed.length, 6);

    // Use exactly the existing operator-controlled, hash-pinned catalog format.
    const catalogFile = path.join(authorDir, 'catalog.json');
    await writeFile(catalogFile, JSON.stringify({schemaVersion:1, adapters:[{
      completionMode:'explicit-text-v1',
      manifest:{schemaVersion:2, type:'example.subprocess.echo',
        adapterId:'example.subprocess.echo.v1', version:'1.0.0', executionMode:'streaming-gateway'},
      command:{executable, sha256:sha256(await readFile(executable)),
        args:['-I', '-B', adapterFile], assets:[{path:adapterFile, sha256:sha256(source)}]},
    }]}), {mode:0o600});
    const adapters = await loadApprovedSubprocessSessionAdapters(catalogFile);
    assert.equal(adapters.length, 1);

    // Build is an explicit prerequisite: no root-suite build/install side effects.
    assert.ok(existsSync(path.join(sdkDir, 'dist/index.js')),
      'run npm --prefix packages/gpulink-sdk run build first');
    const packed = JSON.parse(command('npm', [
      'pack','--offline','--ignore-scripts','--json','--pack-destination',packDir,
    ], sdkDir));
    assert.equal(packed[0].name, '@gpulink/client');
    await writeFile(path.join(consumerDir, 'package.json'),
      '{"name":"gpulink-adapter-e2e-consumer","private":true,"type":"module"}\n');
    command('npm', ['install','--offline','--ignore-scripts','--no-audit','--no-fund',
      path.join(packDir, packed[0].filename)], consumerDir);

    app = createControlPlane({
      host:'127.0.0.1', port:0, dataPath:':memory:', tokens:TOKENS,
      dataPlaneSigningKey:'gpulink-dp3-external-e2e-signing-key-at-least-32-characters',
      dataPlaneGrantTtlMs:15_000, heartbeatTimeoutMs:5_000,
      leaseDurationMs:5_000, schedulerIntervalMs:20, vramSafetyMiB:512,
    });
    const address = await app.start();
    agent = new WorkerAgent({
      controlPlaneUrl:`http://127.0.0.1:${address.port}`,
      token:TOKENS.worker, name:'external-adapter-sdk-acceptance-worker',
      version:'test', heartbeatIntervalMs:100, assignmentIntervalMs:20,
      capabilityProbeIntervalMs:100, capabilities:[], labels:{}, warmModels:[],
      fakeGpus:[{uuid:'GPU-EXTERNAL-ADAPTER-CLIENT-TEST', index:0, name:'Fake GPU',
        memoryTotalMiB:24576, memoryUsedMiB:0, utilizationPercent:0,
        temperatureC:35, powerDrawWatts:25}],
    }, {sessionAdapters:adapters, discoverModelInventory:async () => []});
    await agent.start();

    const workers = await app.database.listWorkers();
    assert.equal(workers.length, 1);
    assert.ok(workers[0].adapterManifests.some(m => m.adapterId === 'example.subprocess.echo.v1'));
    assert.ok(workers[0].capabilities.includes('example.subprocess.echo'));

    const stdout = await runConsumer(clientApp, consumerDir, {
      GPULINK_BASE_URL:`http://127.0.0.1:${address.port}`,
      GPULINK_CLIENT_TOKEN:TOKENS.client,
    });
    assert.match(stdout, /"event":"approved_adapter_client_complete"/);
    const sessions = await app.database.listSessions();
    assert.ok(sessions.some(s => s.status === 'closed'),
      'the public SDK application must release its authoritative session');
  } finally {
    if (agent) await agent.stop();
    if (app) await app.stop();
    await rm(tmp, {recursive:true, force:true});
  }
});
