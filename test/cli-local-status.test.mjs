import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalSetup } from "../src/cli/local-init.mjs";
import { readLocalSmokeSetup } from "../src/cli/local-smoke.mjs";
import { inspectLocalStatus, runLocalStatus } from "../src/cli/local-status.mjs";

function setupFixture(t) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "gpulink-status-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "local");
  createLocalSetup(directory);
  return readLocalSmokeSetup(directory);
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status }); }
function capture() {
  const lines = [];
  const errors = [];
  return { lines, errors, output: { log: (value) => lines.push(value), error: (value) => errors.push(value) } };
}

test("read-only local status classifies a refused loopback connection as offline", async (t) => {
  const setup = setupFixture(t);
  const calls = [];
  const result = await inspectLocalStatus(setup, async (url, options) => {
    calls.push({ url, options });
    throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
  });
  assert.deepEqual(result, {
    schemaVersion: 1, scope: "single-machine-development",
    controlPlane: "offline", localWorker: "unknown", processOwnership: "unverified",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].url, "http://127.0.0.1:8088/readyz");
  assert.equal(calls[0].options.headers, undefined);
});

test("a plausible /readyz response remains unverified and sends no credential", async (t) => {
  const setup = setupFixture(t);
  const visited = [];
  const state = await inspectLocalStatus(setup, async (url, options) => {
    visited.push(url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers, undefined);
    return json({ status: "ready" });
  });
  assert.equal(state.controlPlane, "ready-response-unverified");
  assert.equal(state.localWorker, "unknown");
  assert.equal(state.processOwnership, "unverified");
  assert.deepEqual(visited, ["http://127.0.0.1:8088/readyz"]);
});

test("other services, invalid responses and timeouts never prove ownership", async (t) => {
  const setup = setupFixture(t);
  const cases = [
    async () => json({ status: "ready" }, 404),
    async () => json({ anything: "else" }),
    async () => json({ status: "ready", padding: "x".repeat(5000) }),
    async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
  ];
  for (const fetchImpl of cases) {
    const status = await inspectLocalStatus(setup, fetchImpl);
    assert.equal(status.controlPlane, "unverified");
    assert.equal(status.processOwnership, "unverified");
  }
});

test("status validates setup and never sends a credential or starts a service", async (t) => {
  const setup = setupFixture(t);
  const printed = capture();
  const refused = async () => { throw { cause: { code: "ECONNREFUSED" } }; };
  assert.equal(await runLocalStatus([], setup.directory, { output: printed.output, fetchImpl: refused }), 0);
  assert.equal(JSON.parse(printed.lines[0]).controlPlane, "offline");
  assert.equal(await runLocalStatus(["--bad"], setup.directory, { output: printed.output, fetchImpl: refused }), 2);
  assert.equal(await runLocalStatus([], null, { output: printed.output, fetchImpl: refused }), 1);
  assert.equal(await runLocalStatus([], path.join(setup.directory, "missing"), { output: printed.output,
    fetchImpl: () => { throw Error("Unexpected network access"); } }), 1);
  assert.equal(printed.errors.length, 3);
});

test("a responding unknown process causes a nonzero exit code", async (t) => {
  const setup = setupFixture(t);
  const printed = capture();
  const code = await runLocalStatus([], setup.directory, {
    output: printed.output, fetchImpl: async () => json({ status: "ready" }),
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(printed.lines[0]).controlPlane, "ready-response-unverified");
  const responseText = printed.lines.join("");
  for (const token of [setup.profiles["admin.env"].GPULINK_ADMIN_TOKEN,
    setup.profiles["client.env"].GPULINK_CLIENT_TOKEN,
    setup.profiles["worker.env"].GPULINK_WORKER_TOKEN]) {
    assert.equal(responseText.includes(token), false);
  }
});

test("CLI routes local status for a selected setup from an unrelated cwd", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const setup = setupFixture(t);
  const entry = fileURLToPath(new URL("../src/cli/main.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GPULINK_")));
  const run = spawnSync(process.execPath, [entry, "--config-dir", setup.directory, "local", "status"], {
    cwd: os.tmpdir(), env, encoding: "utf8", timeout: 12_000,
  });
  assert.ok([0, 1].includes(run.status), run.stderr);
  assert.equal(run.stderr, "");
  const result = JSON.parse(run.stdout);
  assert.equal(result.scope, "single-machine-development");
  assert.equal(result.processOwnership, "unverified");
  assert.ok(["offline", "ready-response-unverified", "unverified"].includes(result.controlPlane));
});
