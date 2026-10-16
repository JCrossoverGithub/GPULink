import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlane } from '../../../src/control-plane/app.mjs';
import { createDataPlaneProtocols } from '../../../src/shared/data-plane-contract.mjs';
import { WebSocket as WorkerWebSocket } from 'ws';

// This is TEST HARNESS code: it may create a disposable GPULink control plane.
// The copied example applications are independent consumers of @gpulink/client.
const sdkDir = fileURLToPath(new URL('../', import.meta.url));
const rootDir = resolve(sdkDir, '..', '..');
const exampleDir = join(rootDir, 'examples', 'gpulink-sdk');
const fixtureTokens = {
  client: 'phase5e-external-client-token-at-least-32-characters',
  worker: 'phase5e-external-worker-token-at-least-32-characters',
  admin: 'phase5e-external-admin-token-at-least-32-characters',
};

function fixtureConfig() {
  return {
    host: '127.0.0.1', port: 0, dataPath: ':memory:',
    tokens: fixtureTokens,
    dataPlaneSigningKey: 'phase5e-external-signing-key-at-least-32-characters',
    dataPlaneGrantTtlMs: 15_000,
    heartbeatTimeoutMs: 60_000,
    leaseDurationMs: 30_000,
    schedulerIntervalMs: 60_000,
    vramSafetyMiB: 512,
  };
}

function fixtureWorker() {
  return {
    name: 'phase5e-external-worker', version: 'test', labels: {},
    capabilities: ['speech.streaming'], warmModels: [], modelInventory: [],
    gpus: [{
      uuid: 'GPU-PHASE5E-EXTERNAL', index: 0, name: 'Test GPU',
      memoryTotalMiB: 24_576, memoryUsedMiB: 0,
      utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
    }],
  };
}

async function execNode(args, { cwd, env = {}, onEvent, timeoutMs = 20_000 } = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let unfinished = '';
    let settled = false;
    const pending = [];
    const eventErrors = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      stdout += text;
      unfinished += text;
      const lines = unfinished.split('\n');
      unfinished = lines.pop();
      for (const line of lines) {
        if (!line.trim() || !onEvent) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record.event !== 'string') continue;
        const task = Promise.resolve().then(() => onEvent(record, child)).catch((error) => {
          eventErrors.push(error);
          child.kill();
        });
        pending.push(task);
      }
    });
    child.stderr.on('data', (text) => { stderr += text; });

    const finish = async (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await Promise.all(pending);
        if (eventErrors.length) throw eventErrors[0];
        if (error) throw error;
        if (code !== 0) {
          throw new Error(`consumer process exited ${code}: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`);
        }
        resolvePromise({ stdout, stderr });
      } catch (failure) {
        rejectPromise(failure);
      }
    };
    child.on('error', (error) => { void finish(error, null); });
    child.on('close', (code) => { void finish(null, code); });
  });
}

async function workerSocketOpen(socket) {
  if (socket.readyState === WorkerWebSocket.OPEN) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('external worker open timed out')), 4000);
    socket.once('open', () => { clearTimeout(timer); resolvePromise(); });
    socket.once('error', (error) => { clearTimeout(timer); rejectPromise(error); });
  });
}

test('packed SDK works in independent finite-job and v2 streaming applications', { timeout: 60_000 }, async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli && existsSync(npmCli), 'npm test must supply the npm CLI path');
  const temp = await mkdtemp(join(tmpdir(), 'gpulink-sdk-external-'));
  const packDir = join(temp, 'packed');
  const consumerDir = join(temp, 'consumer');
  let app;
  let workerSocket;
  try {
    await mkdir(packDir);
    await mkdir(consumerDir);
    const packed = await execNode([
      npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', packDir,
    ], { cwd: sdkDir });
    const manifest = JSON.parse(packed.stdout);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].name, '@gpulink/client');
    assert.equal(manifest[0].version, '0.1.0');
    assert.deepEqual(new Set(manifest[0].files.map((file) => file.path)), new Set([
      'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts',
      'dist/data-plane.js', 'dist/data-plane.d.ts',
      'dist/session.js', 'dist/session.d.ts',
    ]));
    const tgz = join(packDir, manifest[0].filename);
    assert.ok(existsSync(tgz));

    await writeFile(join(consumerDir, 'package.json'),
      '{"name":"gpulink-independent-consumer-test","private":true,"type":"module"}\n');
    await execNode([
      npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tgz,
    ], { cwd: consumerDir });
    for (const name of ['finite-job.mjs', 'streaming-v2.mjs', 'typed-consumer.ts']) {
      await copyFile(join(exampleDir, name), join(consumerDir, name));
    }
    await writeFile(join(consumerDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM'],
      },
      include: ['typed-consumer.ts'],
    }, null, 2) + '\n');
    const tsc = join(sdkDir, 'node_modules', 'typescript', 'bin', 'tsc');
    assert.ok(existsSync(tsc));
    await execNode([tsc, '-p', join(consumerDir, 'tsconfig.json')], { cwd: consumerDir });

    app = createControlPlane(fixtureConfig());
    const address = await app.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const env = { GPULINK_BASE_URL: baseUrl, GPULINK_CLIENT_TOKEN: fixtureTokens.client };
    const finite = await execNode([join(consumerDir, 'finite-job.mjs')], { cwd: consumerDir, env });
    assert.match(finite.stdout, /"event":"finite_job_complete"/);

    const worker = await app.service.registerWorker(fixtureWorker());
    let framesReceived = 0;
    let workerFault = null;
    const stream = await execNode([join(consumerDir, 'streaming-v2.mjs')], {
      cwd: consumerDir,
      env: { ...env, GPULINK_EXAMPLE_HARNESS: '1' },
      onEvent: async (event, child) => {
        if (event.event !== 'session_allocated') return;
        assert.equal(typeof event.sessionId, 'string');
        const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(event.sessionId)}`, {
          headers: { Authorization: `Bearer ${fixtureTokens.client}` },
        });
        assert.equal(response.status, 200);
        const { session } = await response.json();
        assert.equal(session.status, 'allocated');
        const connecting = await app.service.startSession(session.id, {
          workerId: worker.id, leaseId: session.leaseId,
        });
        const workerGrant = await app.service.issueDataPlaneGrant(
          connecting.id, 'worker', { workerId: worker.id, leaseId: connecting.leaseId },
        );
        workerSocket = new WorkerWebSocket(
          `ws://127.0.0.1:${address.port}/v1/data-plane`,
          createDataPlaneProtocols(workerGrant.token),
        );
        workerSocket.on('message', (data, isBinary) => {
          if (isBinary && Buffer.from(data).equals(Buffer.from([21, 22, 23]))) {
            framesReceived += 1;
            workerSocket.send('example-worker-response');
          } else {
            workerFault = new Error('unexpected streaming example frame');
          }
        });
        workerSocket.on('error', (error) => { workerFault = error; });
        await workerSocketOpen(workerSocket);
        child.stdin.end('WORKER_STARTED\n');
      },
    });
    assert.match(stream.stdout, /"event":"stream_complete"/);
    assert.equal(framesReceived, 1, 'expected one application binary frame');
    assert.equal(workerFault, null, 'synthetic worker must not fail');

    // Failure after allocation must release the server-side session too.
    let failedSessionId;
    await assert.rejects(
      execNode([join(consumerDir, 'streaming-v2.mjs')], {
        cwd: consumerDir,
        env: { ...env, GPULINK_EXAMPLE_HARNESS: '1' },
        onEvent: (event, child) => {
          if (event.event !== 'session_allocated') return;
          failedSessionId = event.sessionId;
          child.stdin.end('INVALID_WORKER_SIGNAL\n');
        },
      }),
      /unexpected example harness response/,
    );
    assert.equal(typeof failedSessionId, 'string');
    const failedResponse = await fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(failedSessionId)}`,
      { headers: { Authorization: `Bearer ${fixtureTokens.client}` } },
    );
    assert.equal(failedResponse.status, 200);
    const { session: failedSession } = await failedResponse.json();
    assert.equal(failedSession.status, 'closed', 'failed stream setup must release the session');

    console.log('PASS: installed npm tarball, external TypeScript, finite job, v2 streaming and failed-session cleanup');
  } finally {
    workerSocket?.terminate();
    if (app) await app.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
