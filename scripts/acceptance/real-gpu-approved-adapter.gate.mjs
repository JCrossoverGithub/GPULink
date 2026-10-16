/**
 * Explicit, opt-in physical-GPU DP3 gate. Not part of the default test suite.
 * Runs a fixed operator-trusted PyTorch CUDA workload via the existing approved
 * subprocess catalog and a separately installed public Client SDK consumer.
 * No production control plane, models/downloads, deploy, or sandbox claims.
 *
 * Operator must supply GPULINK_ACCEPTED_GPU_PYTHON as an absolute path to an
 * existing GPU-enabled Python environment. Its dependent packages are NOT pinned.
 * Optional GPULINK_REAL_GPU_PACKAGE_ACCEPTANCE=YES_PACKAGED_LOCAL_OPERATOR_TRUSTED
 * exercises a standalone npm Adapter SDK tarball and executes its bundled CUDA
 * program via the same existing operator-trusted catalog/Client SDK path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,copyFile,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createControlPlane} from '../../src/control-plane/app.mjs';
import {WorkerAgent} from '../../src/worker/agent.mjs';
import {loadApprovedSubprocessSessionAdapters} from '../../src/worker/approved-subprocess-adapters.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const sdkDir = path.join(root,'packages/gpulink-sdk');
const adapterSdkDir = path.join(root,'packages/gpulink-adapter-sdk');
const tokens = Object.freeze({
  client:'real-gpu-client-test-token-at-least-32-characters',
  worker:'real-gpu-worker-test-token-at-least-32-characters',
  admin:'real-gpu-admin-test-token-at-least-32-characters',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = s => `'${s.replaceAll("'", "'\\''")}'`;

function command(executable,args,cwd) {
  const result = spawnSync(executable,args,{
    cwd,encoding:'utf8',timeout:25_000,maxBuffer:512_000,
    env:{...process.env,npm_config_audit:'false',npm_config_fund:'false'},
  });
  assert.ifError(result.error);
  assert.equal(result.status,0,`command failed: ${args.join(' ')}: ${String(result.stderr).slice(-1200)}`);
  return result.stdout;
}
async function runConsumer(file,cwd,env) {
  return await new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[file],{
      cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],
    });
    let stdout='';let stderr='';
    const timer = setTimeout(() => child.kill('SIGKILL'),55_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',s => {stdout=(stdout+s).slice(-8000);});
    child.stderr.on('data',s => {stderr=(stderr+s).slice(-8000);});
    child.once('error',reject);
    child.once('close',code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`external client failed (${code}): ${stderr} ${stdout}`));
      else resolve(stdout);
    });
  });
}

test('physical GPU: independently packed Client SDK reaches approved CUDA adapter',
  {timeout:115_000},async () => {
  if (process.env.GPULINK_REAL_GPU_ACCEPTANCE !== 'YES_LOCAL_OPERATOR_TRUSTED') {
    throw new Error('Set GPULINK_REAL_GPU_ACCEPTANCE=YES_LOCAL_OPERATOR_TRUSTED explicitly');
  }
  const packagedMode=process.env.GPULINK_REAL_GPU_PACKAGE_ACCEPTANCE === 'YES_PACKAGED_LOCAL_OPERATOR_TRUSTED';
  const py=process.env.GPULINK_ACCEPTED_GPU_PYTHON;
  if (!py || !path.isAbsolute(py) || !existsSync(py) || py.includes('\n') || py.includes('\r')) {
    throw new Error('Set GPULINK_ACCEPTED_GPU_PYTHON to existing absolute GPU-enabled Python');
  }
  const driverDir = process.env.GPULINK_OPERATOR_CUDA_DRIVER_DIR || null;
  if (driverDir !== null && (!path.isAbsolute(driverDir) || !existsSync(driverDir) ||
      driverDir.includes('\n') || driverDir.includes('\r'))) {
    throw new Error('GPULINK_OPERATOR_CUDA_DRIVER_DIR must be an existing absolute directory');
  }
  const tmp=await mkdtemp(path.join(tmpdir(),'gpulink-physical-gpu-e2e-'));
  let app;let agent;
  try {
    const packDir=path.join(tmp,'pack');
    const consumerDir=path.join(tmp,'client-author');
    const adapterDir=path.join(tmp,'adapter-author');
    await Promise.all([mkdir(packDir),mkdir(consumerDir),mkdir(adapterDir)]);
    const sourceProgram=path.join(adapterDir,'cuda-inference-subprocess.py');
    const scriptBytes=await readFile(path.join(root,'examples/external-adapter/cuda-inference-subprocess.py'));
    await writeFile(sourceProgram,scriptBytes,{mode:0o600});
    const clientApp=path.join(consumerDir,'client.mjs');
    await copyFile(path.join(root,'examples/gpulink-sdk/real-gpu-inference-client.mjs'),clientApp);
    assert.ok(existsSync(path.join(sdkDir,'dist/index.js')),
      'First run: npm --prefix packages/gpulink-sdk run build');
    const packed=JSON.parse(command('npm',[
      'pack','--offline','--ignore-scripts','--json','--pack-destination',packDir,
    ],sdkDir));
    assert.equal(packed[0].name,'@gpulink/client');
    await writeFile(path.join(consumerDir,'package.json'),
      '{"name":"gpulink-real-gpu-consumer","private":true,"type":"module"}\n');
    command('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',
      path.join(packDir,packed[0].filename)],consumerDir);

    let script=sourceProgram;
    const selectedManifest={schemaVersion:2,type:'example.cuda.inference',
      adapterId:'example.cuda.inference.v1',version:'1.0.0',executionMode:'streaming-gateway'};
    if (packagedMode) {
      // This optional gate uses ONLY an independently installed Adapter SDK
      // npm tarball to prepare the external CUDA program package. The operator
      // still owns the launcher and trust decision, never the client.
      const sdkPacked=JSON.parse(command('npm',[
        'pack','--offline','--ignore-scripts','--json','--pack-destination',packDir,
      ],adapterSdkDir));
      assert.equal(sdkPacked[0].name,'@gpulink/adapter-sdk');
      command('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',
        path.join(packDir,sdkPacked[0].filename)],consumerDir);
      const consumerRequire=createRequire(path.join(consumerDir,'package.json'));
      const {assertAdapterCompatibility}=await import(pathToFileURL(
        consumerRequire.resolve('@gpulink/adapter-sdk/contract')).href);
      assert.equal(assertAdapterCompatibility({
        protocol:'gpulink.adapter.ipc',ipcVersion:1,manifestSchemaVersion:2,
        packageSchemaVersion:1,executionMode:'streaming-gateway',
        completionMode:'explicit-text-v1',
      }).compatible,true);
      await writeFile(path.join(adapterDir,'gpulink.adapter.json'),JSON.stringify({
        schemaVersion:1,manifest:selectedManifest,
        entry:'cuda-inference-subprocess.py',completionMode:'explicit-text-v1',
      }));
      const bundleDir=path.join(tmp,'portable-cuda-bundle');
      const cli=path.join(consumerDir,'node_modules/@gpulink/adapter-sdk/bin/package.mjs');
      assert.match(command(process.execPath,[cli,'pack','--source',adapterDir,
        '--out',bundleDir],consumerDir),/PASS: created portable package/u);
      const {inspectAdapter,operatorCatalogCandidate}=await import(pathToFileURL(
        consumerRequire.resolve('@gpulink/adapter-sdk/package')).href);
      const inspected=await inspectAdapter({bundleDir});
      assert.deepEqual(inspected.lock.manifest,selectedManifest);
      assert.equal(inspected.lock.completionMode,'explicit-text-v1');
      assert.equal(inspected.lock.sha256,sha256(scriptBytes));
      // SDK preview is reviewable evidence, not an automatic installation.
      // This test's operator-approved launcher separately supplies WSL's CUDA
      // driver location and the selected venv, with its unpinned dependencies.
      const preview=await operatorCatalogCandidate({bundleDir,interpreter:py});
      assert.deepEqual(preview.adapters[0].manifest,selectedManifest);
      assert.equal(preview.adapters[0].command.assets[0].sha256,inspected.lock.sha256);
      script=inspected.programPath;
      assert.deepEqual(await readFile(script),scriptBytes);
      console.log('PASS: independent Adapter SDK tarball -> pinned CUDA program bundle');
    }

    // Operator-owned development launcher: direct exec replaces the shell PID.
    // The verified bash executable and launcher/adapter source are hash-pinned.
    // The venv interpreter, torch and CUDA shared libraries are NOT transitively
    // pinned; this acceptance must not be described as supply-chain closure.
    const executable=realpathSync('/bin/bash');
    const launcher=path.join(adapterDir,'operator-launcher.sh');
    const launcherBytes=Buffer.from(`#!/bin/bash\nset -euo pipefail\n${
      driverDir === null ? '' : `export LD_LIBRARY_PATH=${shellQuote(driverDir)}\n`
    }exec ${shellQuote(py)} -I -B "$1"\n`);
    await writeFile(launcher,launcherBytes,{mode:0o700});
    const catalogFile=path.join(adapterDir,'approved.json');
    await writeFile(catalogFile,JSON.stringify({schemaVersion:1,adapters:[{
      completionMode:'explicit-text-v1',
      manifest:selectedManifest,
      command:{executable,sha256:sha256(await readFile(executable)),
        args:[launcher,script],assets:[
          {path:launcher,sha256:sha256(launcherBytes)},
          {path:script,sha256:sha256(scriptBytes)},
        ]},
    }]}),{mode:0o600});
    const adapters=await loadApprovedSubprocessSessionAdapters(catalogFile);
    assert.equal(adapters.length,1);

    app=createControlPlane({
      host:'127.0.0.1',port:0,dataPath:':memory:',tokens,
      dataPlaneSigningKey:'real-gpu-acceptance-signing-key-at-least-32-characters',
      dataPlaneGrantTtlMs:15_000,heartbeatTimeoutMs:5_000,
      leaseDurationMs:5_000,schedulerIntervalMs:20,vramSafetyMiB:512,
    });
    const address=await app.start();
    agent=new WorkerAgent({
      controlPlaneUrl:`http://127.0.0.1:${address.port}`,
      token:tokens.worker,name:'physical-gpu-operator-trusted-test-worker',
      version:'test',heartbeatIntervalMs:100,assignmentIntervalMs:20,
      capabilityProbeIntervalMs:100,capabilities:[],labels:{},warmModels:[],
      // IMPORTANT: no fakeGpus. WorkerAgent discovers physical nvidia-smi GPUs.
    },{sessionAdapters:adapters,discoverModelInventory:async()=>[]});
    await agent.start();
    assert.equal(agent.gpus.length,1,'first physical acceptance requires exactly one inventoried GPU');
    const assigned=agent.gpus[0];
    assert.match(assigned.uuid,/^GPU-[a-fA-F0-9-]{32,64}$/u,
      'must be an authentic-looking NVIDIA GPU UUID from nvidia-smi');
    const registered=await app.database.listWorkers();
    assert.equal(registered.length,1);
    assert.ok(registered[0].adapterManifests.some(m => m.adapterId==='example.cuda.inference.v1'));

    const stdout=await runConsumer(clientApp,consumerDir,{
      GPULINK_BASE_URL:`http://127.0.0.1:${address.port}`,
      GPULINK_CLIENT_TOKEN:tokens.client,
    });
    assert.match(stdout,/"event":"real_gpu_adapter_pass"/u);
    // Surface GPU execution evidence from the independently installed client.
    console.log(stdout.trim());
    const sessions=await app.database.listSessions();
    const closed=sessions.filter(s =>
      s.projectId==='external-real-gpu-acceptance' && s.status==='closed');
    assert.equal(closed.length,1,'Client SDK must close exactly one inference session');
    assert.equal(closed[0].assignedWorkerId,null,'closed session must release its worker');
    assert.equal(closed[0].assignedGpuUuid,null,'closed session must release its GPU');
    const events=await app.database.listEventsAfter(0);
    assert.ok(events.some(e => e.type==='session.allocated' &&
      e.subjectId===closed[0].id && e.payload.workerId===registered[0].id &&
      e.payload.gpuUuid===assigned.uuid),
      'scheduler must have assigned the inventoried physical GPU');
    assert.ok(events.some(e => e.type==='session.closed' &&
      e.subjectId===closed[0].id),'Client SDK must persist authoritative close');
  } finally {
    if (agent) await agent.stop();
    if (app) await app.stop();
    await rm(tmp,{recursive:true,force:true});
  }
});
