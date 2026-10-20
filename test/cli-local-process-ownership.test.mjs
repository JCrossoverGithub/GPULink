import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  installationFingerprint, inspectLocalOwnershipCandidates,
  observeLinuxBirth, parseLinuxProcessStart, validateOwnershipRecord,
} from "../src/cli/local-process-ownership.mjs";

const BOOT = "12345678-1234-1234-1234-123456789abc";
function fixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "gpulink-owner-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "installation");
  mkdirSync(directory, { mode: 0o700 });
  return { directory, profiles: { "control-plane.env": {
    GPULINK_DATA_PLANE_SIGNING_KEY: randomBytes(32).toString("hex"),
  } } };
}
function record(setup, role = "control-plane") {
  return {
    schemaVersion: 1, role, installationFingerprint: installationFingerprint(setup),
    pid: 2233, birth: { kind: "linux-procfs", bootId: BOOT, startTicks: "98765" },
    launchId: randomBytes(32).toString("hex"),
  };
}
function writeRecord(setup, data, role = "control-plane") {
  const run = path.join(setup.directory, "run");
  mkdirSync(run, { mode: 0o700, recursive: true });
  const name = path.join(run, `${role}.owner.json`);
  writeFileSync(name, JSON.stringify(data), { mode: 0o600 });
  return name;
}
const probe = () => ({ bootId: BOOT, startTicks: "98765" });

test("missing runtime records are read-only and confer no authority", (t) => {
  const setup = fixture(t);
  assert.deepEqual(inspectLocalOwnershipCandidates(setup), {
    controlPlane: "absent", worker: "absent", authority: "none",
  });
});
test("installation identity is stable for one setup but distinct across setups", (t) => {
  const a = fixture(t), b = fixture(t);
  assert.equal(installationFingerprint(a), installationFingerprint(a));
  assert.notEqual(installationFingerprint(a), installationFingerprint(b));
  assert.equal(validateOwnershipRecord(record(a), b, "control-plane"), false);
  assert.equal(validateOwnershipRecord(record(a, "worker"), a, "control-plane"), false);
});
test("record for a matching Linux PID birth remains UNVERIFIED", (t) => {
  const setup = fixture(t);
  writeRecord(setup, record(setup));
  assert.deepEqual(inspectLocalOwnershipCandidates(setup, { platform: "linux", observeBirth: probe }), {
    controlPlane: "birth-matches-unverified", worker: "absent", authority: "none",
  });
});
test("stale process birth or reboot is rejected; PID alone is insufficient", (t) => {
  const setup = fixture(t);
  writeRecord(setup, record(setup));
  for (const birth of [
    { bootId: BOOT, startTicks: "98766" },
    { bootId: "ffffffff-ffff-ffff-ffff-ffffffffffff", startTicks: "98765" },
  ]) {
    assert.equal(inspectLocalOwnershipCandidates(setup, {
      platform: "linux", observeBirth: () => birth,
    }).controlPlane, "stale");
  }
  assert.equal(inspectLocalOwnershipCandidates(setup, {
    platform: "linux", observeBirth: () => null,
  }).controlPlane, "unverifiable");
});
test("unsupported platforms conservatively refuse to establish process birth", (t) => {
  const setup = fixture(t);
  writeRecord(setup, record(setup));
  assert.equal(inspectLocalOwnershipCandidates(setup, {
    platform: "win32", observeBirth: () => { throw Error("must not probe Linux procfs"); },
  }).controlPlane, "unverifiable");
});
test("invalid or substituted process records are not accepted", (t) => {
  const setup = fixture(t);
  const normal = record(setup);
  const cases = [
    { ...normal, schemaVersion: 2 },
    { ...normal, pid: 0 },
    { ...normal, role: "worker" },
    { ...normal, installationFingerprint: "0".repeat(64) },
    { ...normal, launchId: "insecure" },
    { ...normal, birth: { ...normal.birth, startTicks: "1.5" } },
    { ...normal, extra: true },
  ];
  for (const candidate of cases) {
    assert.equal(validateOwnershipRecord(candidate, setup, "control-plane"), false);
  }
  writeRecord(setup, cases[0]);
  assert.equal(inspectLocalOwnershipCandidates(setup).controlPlane, "invalid");
});
test("symlinked ownership records are invalid", { skip: process.platform === "win32" }, (t) => {
  const setup = fixture(t);
  const name = writeRecord(setup, record(setup));
  rmSync(name);
  const outside = path.join(setup.directory, "outside");
  writeFileSync(outside, JSON.stringify(record(setup)), { mode: 0o600 });
  symlinkSync(outside, name);
  assert.equal(inspectLocalOwnershipCandidates(setup).controlPlane, "invalid");
});
test("oversized ownership records are invalid", (t) => {
  const setup = fixture(t);
  writeRecord(setup, " ".repeat(5000));
  assert.equal(inspectLocalOwnershipCandidates(setup).controlPlane, "invalid");
});
test("symlinked or unsafe runtime directory is invalid for both roles", { skip: process.platform === "win32" }, (t) => {
  const setup = fixture(t);
  const run = path.join(setup.directory, "run");
  symlinkSync(os.tmpdir(), run, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(inspectLocalOwnershipCandidates(setup), {
    controlPlane: "invalid", worker: "invalid", authority: "none",
  });
});
test("POSIX group-readable records fail closed", { skip: process.platform === "win32" }, (t) => {
  const setup = fixture(t);
  const name = writeRecord(setup, record(setup));
  chmodSync(name, 0o644);
  assert.equal(inspectLocalOwnershipCandidates(setup).controlPlane, "invalid");
});
test("Linux /proc/stat parser handles embedded parentheses and rejects zombies", () => {
  const fields = ["S", ...Array(18).fill("0"), "98765", ...Array(5).fill("0")];
  assert.equal(parseLinuxProcessStart(`2233 (worker (sidecar)) ${fields.join(" ")}`), "98765");
  assert.equal(parseLinuxProcessStart(`2233 (worker) Z ${fields.slice(1).join(" ")}`), null);
  assert.equal(parseLinuxProcessStart("nonsense"), null);
  const read = (name) => name.endsWith("boot_id") ? `${BOOT}\n` : `2233 (sidecar) ${fields.join(" ")}`;
  assert.deepEqual(observeLinuxBirth(2233, { read }), { bootId: BOOT, startTicks: "98765" });
  assert.equal(observeLinuxBirth(2233, { read: () => { throw Error("proc missing"); } }), null);
});
