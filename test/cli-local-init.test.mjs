import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { createLocalSetup, runLocalInit } from "../src/cli/local-init.mjs";
import { loadControlPlaneConfig } from "../src/control-plane/config.mjs";
import { loadWorkerConfig } from "../src/worker/config.mjs";
import { inspectRole } from "../src/cli/doctor.mjs";

function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), "gpulink-local-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "deployment");
}
const capture = () => {
  const messages = [];
  return {
    messages,
    log: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
};

test("local init generates independent scoped profiles accepted by existing parsers", (t) => {
  const target = temporary(t);
  const output = capture();
  assert.equal(runLocalInit(["local", target], output), 0);
  const control = parseEnv(readFileSync(path.join(target, "control-plane.env"), "utf8"));
  const worker = parseEnv(readFileSync(path.join(target, "worker.env"), "utf8"));
  const client = parseEnv(readFileSync(path.join(target, "client.env"), "utf8"));
  const admin = parseEnv(readFileSync(path.join(target, "admin.env"), "utf8"));
  assert.deepEqual(readdirSync(target).sort(), ["admin.env", "client.env", "control-plane.env", "worker.env"].sort());
  assert.equal(loadControlPlaneConfig(control).database, "sqlite");
  assert.equal(loadControlPlaneConfig(control).host, "127.0.0.1");
  assert.equal(loadWorkerConfig(worker).name, "local-gpu-worker");
  assert.equal(inspectRole("control-plane", control, { nodeMajor: 24 }).ok, true);
  assert.equal(inspectRole("worker", worker, { nodeMajor: 24 }).ok, true);
  assert.equal(client.GPULINK_CLIENT_TOKEN, control.GPULINK_CLIENT_TOKEN);
  assert.equal(worker.GPULINK_WORKER_TOKEN, control.GPULINK_WORKER_TOKEN);
  assert.equal(admin.GPULINK_ADMIN_TOKEN, control.GPULINK_ADMIN_TOKEN);
  assert.equal(client.GPULINK_ADMIN_TOKEN, undefined);
  assert.equal(worker.GPULINK_ADMIN_TOKEN, undefined);
  const secretNames = ["GPULINK_CLIENT_TOKEN", "GPULINK_WORKER_TOKEN", "GPULINK_ADMIN_TOKEN", "GPULINK_DATA_PLANE_SIGNING_KEY"];
  assert.equal(new Set(secretNames.map((key) => control[key])).size, 4);
  for (const key of secretNames) {
    assert.ok(control[key].length >= 32);
    assert.ok(!output.messages.join("\n").includes(control[key]));
  }
  assert.equal(client.GPULINK_URL, "http://127.0.0.1:8088");
  assert.equal(worker.GPULINK_CONTROL_PLANE_URL, "http://127.0.0.1:8088");
  if (process.platform !== "win32") {
    assert.equal(statSync(target).mode & 0o777, 0o700);
    for (const name of readdirSync(target)) {
      assert.equal(statSync(path.join(target, name)).mode & 0o777, 0o600);
    }
  }
});

test("local init never overwrites an existing directory or credential", (t) => {
  const target = temporary(t);
  createLocalSetup(target);
  const before = readFileSync(path.join(target, "worker.env"), "utf8");
  assert.throws(() => createLocalSetup(target), /already exists/);
  assert.equal(readFileSync(path.join(target, "worker.env"), "utf8"), before);
});

test("local init refuses an existing file as target", (t) => {
  const target = temporary(t);
  writeFileSync(target, "do-not-touch");
  assert.throws(() => createLocalSetup(target), /already exists/);
  assert.equal(readFileSync(target, "utf8"), "do-not-touch");
});

test("invalid CLI arguments do not generate files", (t) => {
  const target = temporary(t);
  const output = capture();
  assert.equal(runLocalInit(["remote", target], output), 2);
  assert.equal(runLocalInit(["local", target, "extra"], output), 2);
  assert.throws(() => readFileSync(path.join(target, "worker.env")), /ENOENT/);
});

test("two independent self-hosted installations receive different secrets", (t) => {
  const root = path.dirname(temporary(t));
  createLocalSetup(path.join(root, "a"));
  createLocalSetup(path.join(root, "b"));
  const a = parseEnv(readFileSync(path.join(root, "a", "control-plane.env"), "utf8"));
  const b = parseEnv(readFileSync(path.join(root, "b", "control-plane.env"), "utf8"));
  assert.notEqual(a.GPULINK_WORKER_TOKEN, b.GPULINK_WORKER_TOKEN);
  assert.notEqual(a.GPULINK_CLIENT_TOKEN, b.GPULINK_CLIENT_TOKEN);
});

test("control-plane doctor describes loopback and non-loopback binds correctly", (t) => {
  const target = temporary(t);
  createLocalSetup(target);
  const control = parseEnv(readFileSync(path.join(target, "control-plane.env"), "utf8"));
  assert.equal(control.GPULINK_CONTROL_HOST, "127.0.0.1");

  const localCheck = inspectRole("control-plane", control, { nodeMajor: 24 })
    .checks.find((item) => item.name === "Control-plane bind");
  assert.equal(localCheck?.status, "PASS");
  assert.match(localCheck.action, /Loopback-only/);

  const externalCheck = inspectRole("control-plane", {
    ...control,
    GPULINK_CONTROL_HOST: "0.0.0.0",
  }, { nodeMajor: 24 }).checks.find((item) => item.name === "Control-plane bind");
  assert.equal(externalCheck?.status, "WARN");
  assert.match(externalCheck.action, /Non-loopback/);
});
