import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SqlitePersistence,
} from "../src/control-plane/persistence/sqlite.mjs";
import {
  createTestContext,
  submitJob,
} from "./helpers.mjs";

test("authoritative queued job state survives a database restart", async () => {
  const directory =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "gpulink-persistence-",
      ),
    );

  const filename =
    path.join(
      directory,
      "control-plane.sqlite",
    );

  const context =
    createTestContext();

  let first = null;
  let second = null;

  try {
    await context.database.close();

    first =
      new SqlitePersistence(filename);

    context.scheduler.database = first;
    context.service.database = first;

    const job = await submitJob(
      context,
      {
        idempotencyKey:
          "persistent-job",
      },
    );

    assert.equal(job.status, "queued");

    await first.close();
    first = null;

    second =
      new SqlitePersistence(filename);

    const persisted =
      await second.getJob(job.id);

    assert.equal(
      persisted.status,
      "queued",
    );

    assert.equal(
      persisted.id,
      job.id,
    );
  } finally {
    if (first) {
      await first.close();
    }

    if (second) {
      await second.close();
    }

    await context.close();

    fs.rmSync(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
