import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlane } from "../src/control-plane/app.mjs";

const tokens = {
  client: "integration-client-token-at-least-32-characters",
  worker: "integration-worker-token-at-least-32-characters",
  admin: "integration-admin-token-at-least-32-characters",
};

test("authenticated HTTP API supports register, submit, lease, start, and finish", async () => {
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    heartbeatTimeoutMs: 60_000,
    leaseDurationMs: 10_000,
    schedulerIntervalMs: 60_000,
    vramSafetyMiB: 512,
  };
  const app = createControlPlane(config);
  const address = await app.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/workers`);
    assert.equal(unauthorized.status, 401);

    const clientCannotRegisterWorker = await request(
      baseUrl,
      "POST",
      "/v1/workers/register",
      {},
      tokens.client,
    );
    assert.equal(clientCannotRegisterWorker.response.status, 401);

    const workerCannotListJobs = await request(
      baseUrl,
      "GET",
      "/v1/jobs",
      undefined,
      tokens.worker,
    );
    assert.equal(workerCannotListJobs.response.status, 401);

    const registration = await request(baseUrl, "POST", "/v1/workers/register", {
      name: "http-worker",
      version: "test",
      labels: {},
      capabilities: ["diagnostic.echo"],
      warmModels: [],
      gpus: [{
        uuid: "GPU-HTTP",
        index: 0,
        name: "HTTP Test GPU",
        memoryTotalMiB: 24576,
        memoryUsedMiB: 0,
        utilizationPercent: 0,
        temperatureC: 40,
        powerDrawWatts: 40,
      }],
    }, tokens.worker);
    assert.equal(registration.response.status, 200);

    const submitted = await request(baseUrl, "POST", "/v1/jobs", {
      projectId: "test",
      type: "diagnostic.echo",
      constraints: { minVramMiB: 1000 },
      payload: { echo: "hello" },
    }, tokens.client);
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.body.job.status, "leased");

    const workerId = registration.body.worker.id;
    const leases = await request(
      baseUrl,
      "GET",
      `/v1/workers/${workerId}/leases`,
      undefined,
      tokens.worker,
    );
    assert.equal(leases.body.jobs.length, 1);
    const job = leases.body.jobs[0];

    const started = await request(baseUrl, "POST", `/v1/jobs/${job.id}/start`, {
      workerId,
      leaseId: job.leaseId,
    }, tokens.worker);
    assert.equal(started.body.job.status, "running");

    const finished = await request(baseUrl, "POST", `/v1/jobs/${job.id}/finish`, {
      workerId,
      leaseId: job.leaseId,
      outcome: "succeeded",
      result: { echo: "hello" },
    }, tokens.worker);
    assert.equal(finished.body.job.status, "succeeded");

    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${tokens.admin}` },
    });
    const metricsText = await metrics.text();
    assert.match(metricsText, /gpulink_jobs\{status="succeeded"\} 1/u);
  } finally {
    await app.stop();
  }
});

async function request(baseUrl, method, path, body = undefined, token = tokens.client) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}
