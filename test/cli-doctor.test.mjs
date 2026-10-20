import assert from "node:assert/strict";
import test from "node:test";
import { inspectRole, runDoctor } from "../src/cli/doctor.mjs";

const secret = (suffix) => `secret-credential-${suffix}-${"x".repeat(40)}`;
const control = {
  GPULINK_CLIENT_TOKEN: secret("client"),
  GPULINK_WORKER_TOKEN: secret("worker"),
  GPULINK_ADMIN_TOKEN: secret("admin"),
  GPULINK_DATA_PLANE_SIGNING_KEY: secret("signing"),
};
const worker = {
  GPULINK_WORKER_NAME: "gpu-host-1",
  GPULINK_WORKER_TOKEN: secret("worker"),
  GPULINK_CONTROL_PLANE_URL: "https://operator.example.invalid",
};

function capture() {
  const messages = [];
  return { messages, log: (message) => messages.push(message), error: (message) => messages.push(message) };
}

test("control-plane validates against existing parser without disclosing secrets", () => {
  const output = capture();
  assert.equal(runDoctor(["control-plane"], control, output, { nodeMajor: 24 }), 0);
  assert.match(output.messages.join("\n"), /preflight passed/);
  for (const value of Object.values(control)) assert.ok(!output.messages.join("\n").includes(value));
});

test("worker accepts HTTPS with an optional absent catalog", () => {
  const report = inspectRole("worker", worker, { nodeMajor: 24 });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.status === "WARN"));
});

test("worker rejects off-loopback HTTP", () => {
  const report = inspectRole("worker", { ...worker, GPULINK_CONTROL_PLANE_URL: "http://operator.example.invalid:8088" }, { nodeMajor: 24 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === "Worker control-plane origin").status, "FAIL");
});

test("worker allows HTTP loopback for operator-trusted local development", () => {
  assert.equal(inspectRole("worker", { ...worker, GPULINK_CONTROL_PLANE_URL: "http://127.0.0.1:8088" }, { nodeMajor: 24 }).ok, true);
});

test("control-plane rejects missing secrets and duplicate credentials", () => {
  assert.equal(inspectRole("control-plane", {}, { nodeMajor: 24 }).ok, false);
  const duplicate = { ...control, GPULINK_ADMIN_TOKEN: control.GPULINK_CLIENT_TOKEN };
  const report = inspectRole("control-plane", duplicate, { nodeMajor: 24 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === "Credential separation").status, "FAIL");
});

test("existing control-plane config rejects malformed JSON", () => {
  const report = inspectRole("control-plane", { ...control, GPULINK_BROKER_PROFILES_JSON: "{not json" }, { nodeMajor: 24 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === "Control-plane config parser").status, "FAIL");
});

test("doctor rejects roles it cannot diagnose; never contacts an endpoint", () => {
  const output = capture();
  assert.equal(runDoctor(["client"], {}, output, { nodeMajor: 24 }), 2);
  assert.match(output.messages.join("\n"), /Usage/);
});

test("Node.js below supported major version fails", () => {
  assert.equal(inspectRole("worker", worker, { nodeMajor: 22 }).ok, false);
});
