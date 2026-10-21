import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeWorkerControlPlaneUrl } from "../src/worker/config.mjs";
import { inspectRole } from "../src/cli/doctor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliUrl = pathToFileURL(path.join(root, "src/cli/main.mjs")).href;
const token = "synthetic-pr28-only-" + "x".repeat(64);

function cliWorkerList(endpoint) {
  // Subprocess fetch is fully stubbed: no network, service or hardware access.
  const script = `
    process.argv = [process.execPath, "gpulink", "workers"];
    globalThis.fetch = async (url, options) => {
      console.log("PR28_FETCH:" + JSON.stringify({
        url, redirect: options.redirect,
        bearerCorrect: options.headers.Authorization === ${JSON.stringify(`Bearer ${token}`)},
      }));
      return { ok: true, json: async () => ({ workers: [] }) };
    };
    await import(${JSON.stringify(cliUrl)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(os.tmpdir(), `gpulink-pr28-absent-home-${process.pid}`),
      GPULINK_URL: endpoint,
      GPULINK_ADMIN_TOKEN: token,
    },
  });
}

test("two-host policy shares the accepted exact-loopback and remote HTTPS validator", () => {
  for (const url of ["http://127.0.0.1:8088", "http://localhost:8088", "http://[::1]:8088", "https://host-a.example.invalid"]) {
    assert.ok(normalizeWorkerControlPlaneUrl(url));
  }
  for (const url of [
    "http://192.0.2.5:8088", "http://host-a.example.invalid",
    "http://localhost.evil.invalid", "http://localhost.:8088",
    "http://[::ffff:127.0.0.1]", "ftp://host-a.example.invalid",
    "https://user:pass@host-a.example.invalid", "https://host-a.example.invalid/?secret=bad",
    "https://host-a.example.invalid/#token",
  ]) assert.throws(() => normalizeWorkerControlPlaneUrl(url));
});

test("operator CLI rejects remote HTTP before calling its fetch stub", () => {
  const result = cliWorkerList("http://host-a.example.invalid:8088");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /GPULINK_URL requires HTTPS/);
  assert.doesNotMatch(result.stdout, /PR28_FETCH:/);
  assert.doesNotMatch(result.stderr, new RegExp(token));
});

test("operator CLI sends bearer only to HTTPS with redirect refusal", () => {
  const result = cliWorkerList("https://host-a.example.invalid/");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PR28_FETCH:/);
  assert.match(result.stdout, /"url":"https:\/\/host-a\.example\.invalid\/v1\/workers"/);
  assert.match(result.stdout, /"redirect":"error"/);
  assert.match(result.stdout, /"bearerCorrect":true/);
});

test("operator CLI preserves exact localhost HTTP for local-only development", () => {
  const result = cliWorkerList("http://127.0.0.1:8088");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"url":"http:\/\/127\.0\.0\.1:8088\/v1\/workers"/);
  assert.match(result.stdout, /"redirect":"error"/);
});

test("offline control-plane and worker role checks reject unsafe synthetic profiles", () => {
  const control = {
    GPULINK_CLIENT_TOKEN: token + "c", GPULINK_WORKER_TOKEN: token + "w",
    GPULINK_ADMIN_TOKEN: token + "a", GPULINK_DATA_PLANE_SIGNING_KEY: token + "s",
    GPULINK_CONTROL_HOST: "127.0.0.1", GPULINK_CONTROL_DATABASE: "sqlite",
  };
  assert.equal(inspectRole("control-plane", control, { nodeMajor: 24 }).ok, true);
  assert.equal(inspectRole("control-plane", { ...control, GPULINK_ADMIN_TOKEN: control.GPULINK_WORKER_TOKEN }, { nodeMajor: 24 }).ok, false);
  const worker = { GPULINK_WORKER_NAME: "synthetic-independent-worker", GPULINK_WORKER_TOKEN: token,
    GPULINK_CONTROL_PLANE_URL: "https://host-a.example.invalid" };
  assert.equal(inspectRole("worker", worker, { nodeMajor: 24 }).ok, true);
  assert.equal(inspectRole("worker", { ...worker, GPULINK_CONTROL_PLANE_URL: "http://host-a.example.invalid" }, { nodeMajor: 24 }).ok, false);
});

test("public example has each CP credential once, and fails closed before secrets are supplied", () => {
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const key of ["GPULINK_CLIENT_TOKEN", "GPULINK_WORKER_TOKEN", "GPULINK_ADMIN_TOKEN", "GPULINK_DATA_PLANE_SIGNING_KEY"]) {
    const matched = [...example.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
    assert.equal(matched.length, 1, `${key} should occur exactly once`);
    assert.equal(matched[0][1], "REPLACE_ME");
  }
  const doc = readFileSync(path.join(root, "docs/INDEPENDENT_TWO_HOST_OPERATOR.md"), "utf8");
  for (let n = 0; n <= 9; n++) assert.ok(doc.includes(`| G${n} |`), `missing gate G${n}`);
  assert.match(doc, /No PID-only termination/);
});
