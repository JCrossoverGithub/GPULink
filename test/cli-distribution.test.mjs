import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultLocalSetupDirectory, parseGlobalCliOptions } from "../src/cli/setup-directory.mjs";
import { prepareCliPackage } from "../scripts/build-cli-package.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "gpulink-cli-distribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src", "cli"), { recursive: true });
  mkdirSync(path.join(repo, "src", "control-plane"), { recursive: true });
  mkdirSync(path.join(repo, "src", "worker"), { recursive: true });
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "gpulink", private: true, version: "0.1.0", type: "module",
    engines: { node: ">=24.0.0" }, dependencies: { ws: "8.22.0" },
  }));
  writeFileSync(path.join(repo, "LICENSE"), "Apache-2.0 test fixture\n");
  for (const file of ["cli/main.mjs", "control-plane/main.mjs", "worker/main.mjs"]) {
    writeFileSync(path.join(repo, "src", file), "export {};\n");
  }
  return { root, repo };
}

test("canonical local installation path is independent of the current working directory", () => {
  assert.equal(defaultLocalSetupDirectory(), path.join(os.homedir(), ".gpulink", "instances", "local"));
  assert.ok(path.isAbsolute(defaultLocalSetupDirectory()));
});

test("explicit configuration directory is normalized without changing command arguments", () => {
  const result = parseGlobalCliOptions(["--config-dir", "./another-instance", "doctor", "worker"]);
  assert.equal(result.directory, path.resolve("./another-instance"));
  assert.deepEqual(result.args, ["doctor", "worker"]);
  assert.deepEqual(parseGlobalCliOptions(["jobs"]), { args: ["jobs"], directory: null });
});

test("global CLI option refuses a missing configuration directory", () => {
  assert.throws(() => parseGlobalCliOptions(["--config-dir"]), /requires/);
  assert.throws(() => parseGlobalCliOptions(["--config-dir", "--help"]), /requires/);
});

test("a separate private CLI artifact contains the matching Core but excludes repository internals", (t) => {
  const { root, repo } = fixture(t);
  const dest = path.join(root, "staging");
  prepareCliPackage(repo, dest);
  const pkg = JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8"));
  assert.equal(pkg.name, "@gpulink/cli");
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin.gpulink, "./src/cli/main.mjs");
  assert.equal(pkg.dependencies.ws, "8.22.0");
  assert.ok(existsSync(path.join(dest, "src/worker/main.mjs")));
  assert.ok(existsSync(path.join(dest, "src/control-plane/main.mjs")));
  assert.ok(!existsSync(path.join(dest, "scripts")));
  assert.ok(!existsSync(path.join(dest, "test")));
  assert.throws(() => prepareCliPackage(repo, dest), /already exists/);
});

test("packaging fails closed when private credentials appear under source", (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(path.join(repo, "src", "unwanted.env"), "TOP_SECRET=not-for-publication\n");
  const dest = path.join(root, "staging");
  assert.throws(() => prepareCliPackage(repo, dest), /Credential/);
  assert.equal(existsSync(dest), false);
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "main.mjs");
function execute(args, cwd, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GPULINK_")));
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
}
test("CLI can initialize and diagnose its chosen setup from another working directory", (t) => {
  const { root } = fixture(t);
  const installation = path.join(root, "independent-installation");
  const working = path.join(root, "unrelated-cwd");
  mkdirSync(working);
  const init = execute(["--config-dir", installation, "init", "local"], working);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(path.join(installation, "worker.env")));
  const cp = execute(["--config-dir", installation, "doctor", "control-plane"], working);
  assert.equal(cp.status, 0, cp.stderr);
  assert.match(cp.stdout, /preflight passed/);
  const worker = execute(["--config-dir", installation, "doctor", "worker"], working);
  assert.equal(worker.status, 0, worker.stderr);
  const version = execute(["--version"], working);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.1\.0/);
  const help = execute(["--help"], working);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /gpulink.*config-dir/);
});
test("selected local installation does not silently mix inherited credentials", (t) => {
  const { root } = fixture(t);
  const installation = path.join(root, "separate");
  assert.equal(execute(["init", "local", installation], root).status, 0);
  const invalid = execute(["--config-dir", installation, "doctor", "control-plane"], root,
    { GPULINK_CLIENT_TOKEN: "inherited-secret" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Inherited GPULINK_CLIENT_TOKEN conflicts/);
});

test("local smoke gives every owned subprocess the selected private setup as cwd", async (t) => {
  const { root } = fixture(t);
  const { createLocalSetup } = await import("../src/cli/local-init.mjs");
  const { exerciseLocalSmoke, readLocalSmokeSetup } = await import("../src/cli/local-smoke.mjs");
  const directory = path.join(root, "private-local");
  createLocalSetup(directory);
  const setup = readLocalSmokeSetup(directory);
  let observed = 0;
  const operations = {
    portAvailable: async () => {},
    launch: async (_script, _profile, cwd) => { assert.equal(cwd, setup.directory); observed++; return {}; },
    ready: async () => {},
    event: async (_child, event) => event === "worker_registered"
      ? { workerId: "worker_abcdef12", gpuCount: 1 } : { jobId: "job_abcdef12" },
    client: async (_profile, args, _signal, cwd) => {
      assert.equal(cwd, setup.directory);
      observed++;
      if (args[0] === "workers") return { workers: [{ id: "worker_abcdef12", status: "online", gpus: [{ name: "GPU" }], capabilities: ["diagnostic.gpu-status"] }] };
      if (args[0] === "submit-diagnostic") return { job: { id: "job_abcdef12", type: "diagnostic.gpu-status" } };
      return { job: { id: "job_abcdef12", type: "diagnostic.gpu-status", status: "succeeded" } };
    },
    stop: async () => {},
  };
  const captured = { log() {} };
  await exerciseLocalSmoke(setup, operations, captured);
  assert.equal(observed, 5);
});
