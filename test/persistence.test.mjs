import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/control-plane/database.mjs";
import { createTestContext, submitJob } from "./helpers.mjs";

test("authoritative queued job state survives a database restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-platform-test-"));
  const filename = path.join(directory, "control-plane.sqlite");
  let first;
  let second;
  try {
    first = new ControlPlaneDatabase(filename);
    const context = createTestContext();
    context.database.close();
    context.database = first;
    context.scheduler.database = first;
    context.service.database = first;

    const job = submitJob(context, { idempotencyKey: "persistent-job" });
    assert.equal(job.status, "queued");
    first.close();
    first = null;

    second = new ControlPlaneDatabase(filename);
    const restored = second.getJob(job.id);
    assert.equal(restored.status, "queued");
    assert.equal(restored.idempotencyKey, "persistent-job");
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
