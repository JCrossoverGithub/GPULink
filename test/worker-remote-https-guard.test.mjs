import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkerConfig, normalizeWorkerControlPlaneUrl } from "../src/worker/config.mjs";
import { ControlPlaneClient } from "../src/worker/control-plane-client.mjs";
import { inspectRole } from "../src/cli/doctor.mjs";

const token = "synthetic-worker-credential-" + "x".repeat(64);
const base = {
  GPULINK_WORKER_NAME: "synthetic-no-network-worker",
  GPULINK_WORKER_TOKEN: token,
};
function worker(url) {
  return loadWorkerConfig({ ...base, GPULINK_CONTROL_PLANE_URL: url });
}

// All cases are parser-only: no GPU, network, or services.
test("local-only HTTP remains permitted for exact loopback hosts", () => {
  assert.equal(loadWorkerConfig(base).controlPlaneUrl, "http://127.0.0.1:8088");
  for (const url of [
    "http://127.0.0.1:8088/",
    "http://localhost:8088",
    "http://[::1]:8088",
  ]) {
    assert.equal(worker(url).controlPlaneUrl, normalizeWorkerControlPlaneUrl(url));
    assert.ok(new ControlPlaneClient(url, token));
    assert.equal(inspectRole("worker", { ...base, GPULINK_CONTROL_PLANE_URL: url }, { nodeMajor: 24 }).ok, true);
  }
});

test("remote HTTPS is allowed without pretending TLS trust has been verified", () => {
  const url = "https://operator-preflight.invalid:443/";
  assert.equal(worker(url).controlPlaneUrl, "https://operator-preflight.invalid");
  assert.equal(new ControlPlaneClient(url, token).baseUrl, "https://operator-preflight.invalid");
  assert.equal(inspectRole("worker", { ...base, GPULINK_CONTROL_PLANE_URL: url }, { nodeMajor: 24 }).ok, true);
});

test("remote HTTP, loopback lookalikes and non-HTTP protocols fail before HTTP client creation", () => {
  for (const url of [
    "http://192.0.2.25:8088",
    "http://operator-preflight.invalid:8088",
    "http://127.0.0.1.evil.invalid:8088",
    "http://localhost.evil.invalid:8088",
    "http://localhost.:8088",
    "http://0.0.0.0:8088",
    "http://[::ffff:127.0.0.1]:8088",
    "ftp://operator-preflight.invalid",
    "ws://127.0.0.1:8088",
  ]) {
    assert.throws(() => worker(url), /GPULINK_CONTROL_PLANE_URL/);
    assert.throws(() => new ControlPlaneClient(url, token), /GPULINK_CONTROL_PLANE_URL/);
    assert.equal(inspectRole("worker", { ...base, GPULINK_CONTROL_PLANE_URL: url }, { nodeMajor: 24 }).ok, false);
  }
});

test("URLs with embedded credentials, query, or fragments are rejected", () => {
  for (const url of [
    "https://user:pass@operator-preflight.invalid",
    "https://operator-preflight.invalid/?token=hidden",
    "https://operator-preflight.invalid/#hidden",
    "http://localhost:8088/?key=hidden",
  ]) {
    assert.throws(() => worker(url), /GPULINK_CONTROL_PLANE_URL/);
    assert.throws(() => new ControlPlaneClient(url, token), /GPULINK_CONTROL_PLANE_URL/);
  }
});

test("invalid destination never invokes the outbound fetch API or exposes the bearer", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected network call"); };
  try {
    assert.throws(() => new ControlPlaneClient("http://192.0.2.1:8088", token), (error) => {
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("credential-bearing requests refuse redirects and preserve a trusted HTTPS origin", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://operator-preflight.invalid/v1/workers/register");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return { ok: true, json: async () => ({ worker: { id: "worker_synthetic" } }) };
  };
  try {
    const response = await new ControlPlaneClient("https://operator-preflight.invalid", token)
      .registerWorker({ name: "synthetic" });
    assert.equal(response.worker.id, "worker_synthetic");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
