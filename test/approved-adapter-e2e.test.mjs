import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { createControlPlane } from "../src/control-plane/app.mjs";
import { WorkerAgent } from "../src/worker/agent.mjs";
import { loadApprovedSessionAdapters } from "../src/worker/approved-session-adapters.mjs";
import { DATA_PLANE_PATH, createDataPlaneProtocols } from "../src/shared/data-plane-contract.mjs";

const CAPABILITY = "example.echo.streaming";
const ADAPTER_ID = "example.echo.streaming.v1";
const TOKENS = {
  client: "dp3b-client-test-token-long-enough-123",
  worker: "dp3b-worker-test-token-long-enough-123",
  admin: "dp3b-admin-test-token-long-enough-123",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("independent approved adapter is registered, pinned, and exchanges opaque frames", {
  timeout: 15_000,
}, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "gpulink-dp3b-e2e-"));
  let app = null;
  let agent = null;
  let socket = null;
  let session = null;
  try {
    const examplePath = fileURLToPath(new URL("../examples/external-adapter/echo-stream.mjs", import.meta.url));
    const source = await readFile(examplePath);
    const entrypoint = path.join(tmp, "third-party-echo.mjs");
    const catalogPath = path.join(tmp, "catalog.json");
    await writeFile(entrypoint, source, { mode: 0o600 });
    await writeFile(catalogPath, JSON.stringify({
      schemaVersion: 1,
      adapters: [{
        manifest: {
          schemaVersion: 2,
          type: CAPABILITY,
          adapterId: ADAPTER_ID,
          version: "1.0.0",
          executionMode: "streaming-gateway",
        },
        entrypoint,
        sha256: createHash("sha256").update(source).digest("hex"),
      }],
    }), { mode: 0o600 });

    const adapters = await loadApprovedSessionAdapters(catalogPath);
    app = createControlPlane({
      host: "127.0.0.1", port: 0, dataPath: ":memory:",
      tokens: TOKENS,
      dataPlaneSigningKey: "dp3b-local-only-signing-key-at-least-32-characters",
      dataPlaneGrantTtlMs: 15_000,
      heartbeatTimeoutMs: 5_000,
      leaseDurationMs: 5_000,
      schedulerIntervalMs: 20,
      vramSafetyMiB: 512,
    });
    const address = await app.start();

    agent = new WorkerAgent({
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      token: TOKENS.worker,
      name: "dp3b-operator-approved-external-adapter",
      version: "test",
      heartbeatIntervalMs: 100,
      assignmentIntervalMs: 20,
      capabilityProbeIntervalMs: 100,
      capabilities: [], labels: {}, warmModels: [],
      fakeGpus: [{
        uuid: "GPU-DP3B-E2E", index: 0, name: "DP3B Fake GPU",
        memoryTotalMiB: 24_576, memoryUsedMiB: 0,
        utilizationPercent: 0, temperatureC: 35, powerDrawWatts: 25,
      }],
    }, { sessionAdapters: adapters, discoverModelInventory: async () => [] });
    await agent.start();
    const workers = await app.database.listWorkers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].adapterManifests.some(
      (item) => item.adapterId === ADAPTER_ID,
    ), true);
    assert.equal(workers[0].capabilities.includes(CAPABILITY), true);

    session = (await app.service.submitSession({
      projectId: "dp3b-e2e",
      capability: CAPABILITY,
      requirements: {
        minVramMiB: 1_000, capabilities: [CAPABILITY], adapter: ADAPTER_ID,
      },
      recovery: { maxInterruptions: 0 },
    })).session;
    assert.equal(session.status, "allocated");

    await waitFor(async () =>
      (await app.database.getSession(session.id))?.status === "connecting",
    "worker connecting session");
    const clientGrant = await app.service.issueDataPlaneGrant(session.id, "client");
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
      createDataPlaneProtocols(clientGrant.token),
      { perMessageDeflate: false },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(async () =>
      (await app.database.getSession(session.id))?.status === "active",
    "active authenticated relay");

    const incoming = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("echo timeout")), 2_000);
      socket.once("message", (data, isBinary) => {
        clearTimeout(timeout);
        resolve({ data: Buffer.from(data), isBinary });
      });
    });
    const payload = Buffer.from([1, 255, 0, 42]);
    socket.send(payload, { binary: true });
    const echo = await incoming;
    assert.equal(echo.isBinary, true);
    assert.deepEqual(echo.data, payload);

    await app.service.closeSession(session.id);
    await waitFor(async () =>
      (await app.database.getSession(session.id))?.status === "closed",
    "authoritative close");
  } finally {
    if (session?.id && app) {
      try { await app.service.closeSession(session.id); } catch { /* already closed */ }
    }
    socket?.terminate();
    if (agent) await agent.stop();
    if (app) await app.stop();
    await rm(tmp, { recursive: true, force: true });
  }
});
