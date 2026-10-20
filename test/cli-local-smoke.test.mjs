import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalSetup } from "../src/cli/local-init.mjs";
import { exerciseLocalSmoke, readLocalSmokeSetup, runLocalSmoke } from "../src/cli/local-smoke.mjs";

function localFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "gpulink-local-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "self-hosted-local");
  createLocalSetup(directory);
  return directory;
}

function fakeLifecycle({ failAt = "" } = {}) {
  const actions = [];
  const service = (kind) => ({ kind });
  return {
    actions,
    portAvailable: async () => {
      actions.push("port");
      if (failAt === "port") throw Error("occupied");
    },
    launch: async (script) => {
      const kind = script.includes("control-plane") ? "control" : "worker";
      actions.push(`launch:${kind}`);
      return service(kind);
    },
    ready: async () => {
      actions.push("ready");
      if (failAt === "ready") throw Error("not ready");
    },
    event: async (_child, name, predicate) => {
      actions.push(`event:${name}`);
      if (name === "worker_registered") return { workerId: "worker_1234abcd", gpuCount: 1 };
      const event = { jobId: "job_abcd1234" };
      if (predicate && !predicate(event)) throw Error("wrong job");
      return event;
    },
    client: async (_profile, args) => {
      actions.push(`client:${args[0]}`);
      if (args[0] === "workers") return { workers: [{ id: "worker_1234abcd", status: "online", drainMode: false, gpus: [{ name: "GPU" }], capabilities: ["diagnostic.gpu-status"] }] };
      if (args[0] === "submit-diagnostic") return { job: { id: "job_abcd1234", type: "diagnostic.gpu-status" } };
      if (args[0] === "wait") return { job: { id: "job_abcd1234", type: "diagnostic.gpu-status", status: failAt === "job" ? "failed" : "succeeded", result: { gpu: { name: "GPU" } } } };
      throw Error("unexpected command");
    },
    stop: async (child) => { if (child) actions.push(`stop:${child.kind}`); },
  };
}

const output = () => ({ lines: [], log(message) { this.lines.push(message); }, error(message) { this.lines.push(message); } });

test("smoke requires explicit real-GPU opt-in without touching local setup", async () => {
  const captured = output();
  assert.equal(await runLocalSmoke(["smoke"], captured), 2);
  assert.match(captured.lines.join(" "), /--real-gpu/);
});

test("validates init-local profile ownership, endpoints, and role-scoped secrets", (t) => {
  const directory = localFixture(t);
  const setup = readLocalSmokeSetup(directory);
  assert.equal(setup.profiles["client.env"].GPULINK_URL, "http://127.0.0.1:8088");
  assert.equal(setup.profiles["control-plane.env"].GPULINK_CONTROL_DATA_PATH,
    path.join(directory, "control-plane.sqlite"));
  assert.notEqual(setup.profiles["worker.env"].GPULINK_WORKER_TOKEN,
    setup.profiles["client.env"].GPULINK_CLIENT_TOKEN);
});

test("local smoke rejects modified network-facing configuration", (t) => {
  const directory = localFixture(t);
  const file = path.join(directory, "worker.env");
  const original = readFileSync(file, "utf8");
  const updated = original.replace("127.0.0.1:8088", "example.com:8088");
  writeFileSync(file, updated);
  assert.throws(() => readLocalSmokeSetup(directory), /local-only origin/);
});


test("local smoke rejects a symlinked credential", (t) => {
  const directory = localFixture(t);
  const file = path.join(directory, "admin.env");
  const data = readFileSync(file, "utf8");
  rmSync(file);
  const alternate = path.join(directory, "alternate.env");
  writeFileSync(alternate, data, { mode: 0o600 });
  try { symlinkSync(alternate, file); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Symlink creation unavailable under this Windows security policy.");
      return;
    }
    throw error;
  }
  assert.throws(() => readLocalSmokeSetup(directory), /regular file/);
});

test("POSIX local smoke rejects over-permissive credentials", { skip: process.platform === "win32" }, (t) => {
  const directory = localFixture(t);
  chmodSync(path.join(directory, "worker.env"), 0o644);
  assert.throws(() => readLocalSmokeSetup(directory), /unsafe permissions/);
});

test("simulated lifecycle proves worker event, authoritative success, and reverse cleanup", async (t) => {
  const setup = readLocalSmokeSetup(localFixture(t));
  const runtime = fakeLifecycle();
  const result = await exerciseLocalSmoke(setup, runtime, output());
  assert.equal(result.id, "job_abcd1234");
  assert.equal(result.gpu, "GPU");
  assert.deepEqual(runtime.actions.slice(-2), ["stop:worker", "stop:control"]);
  assert.ok(runtime.actions.includes("event:job_succeeded"));
});

test("failed GPU diagnostic never claims success and cleans up both owned processes", async (t) => {
  const setup = readLocalSmokeSetup(localFixture(t));
  const runtime = fakeLifecycle({ failAt: "job" });
  const captured = output();
  await assert.rejects(() => exerciseLocalSmoke(setup, runtime, captured), /did not complete/);
  assert.deepEqual(runtime.actions.slice(-2), ["stop:worker", "stop:control"]);
  assert.ok(!captured.lines.some((line) => line.includes("Scheduled GPU diagnostic succeeded")));
});

test("early failure stops only the child actually started", async (t) => {
  const setup = readLocalSmokeSetup(localFixture(t));
  const runtime = fakeLifecycle({ failAt: "ready" });
  await assert.rejects(() => exerciseLocalSmoke(setup, runtime, output()), /not ready/);
  assert.deepEqual(runtime.actions, ["port", "launch:control", "ready", "stop:control"]);
});

test("occupied port does not launch or stop any process", async (t) => {
  const setup = readLocalSmokeSetup(localFixture(t));
  const runtime = fakeLifecycle({ failAt: "port" });
  await assert.rejects(() => exerciseLocalSmoke(setup, runtime, output()), /occupied/);
  assert.deepEqual(runtime.actions, ["port"]);
});
