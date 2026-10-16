import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, chmod, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadApprovedSessionAdapters } from "../src/worker/approved-session-adapters.mjs";
import { loadWorkerConfig } from "../src/worker/config.mjs";

const manifest = {
  schemaVersion: 2,
  type: "example.echo.streaming",
  adapterId: "example.echo.streaming.v1",
  version: "1.0.0",
  executionMode: "streaming-gateway",
};

const source = `export function createAdapter() {
 return {
 manifest: ${JSON.stringify(manifest)},
 readinessProbe: async () => true,
 handleSession: async () => {},
 };
}`;

async function fixture(callback, { code = source, config = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "gpulink-dp3b-"));
  try {
    const entrypoint = path.join(dir, "external.mjs");
    const catalog = path.join(dir, "catalog.json");
    await writeFile(entrypoint, code, { mode: 0o600 });
    const spec = {
      manifest,
      entrypoint,
      sha256: createHash("sha256").update(code).digest("hex"),
    };
    await writeFile(catalog, JSON.stringify(
      config ?? { schemaVersion: 1, adapters: [spec] },
    ), { mode: 0o600 });
    return await callback({ dir, entrypoint, catalog, spec });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("catalog omitted means no external code is loaded", async () => {
  assert.deepEqual(await loadApprovedSessionAdapters(), []);
  assert.deepEqual(await loadApprovedSessionAdapters(null), []);
});

test("external single-file adapter is loaded from pinned source bytes", async () => {
  await fixture(async ({ catalog }) => {
    const adapters = await loadApprovedSessionAdapters(catalog);
    assert.equal(adapters.length, 1);
    assert.deepEqual(adapters[0].manifest, manifest);
    assert.equal(await adapters[0].readinessProbe(), true);
    await adapters[0].handleSession();
  });
});

test("unapproved file mutations fail before code evaluation", async () => {
  await fixture(async ({ catalog, entrypoint }) => {
    await writeFile(entrypoint, source + "\nthrow new Error('executed');", { mode: 0o600 });
    await assert.rejects(
      loadApprovedSessionAdapters(catalog),
      { code: "entrypoint_digest_mismatch" },
    );
  });
});

test("all source hashes must validate before any adapter executes", async () => {
  await fixture(async ({ catalog, spec, dir }) => {
    const evil = path.join(dir, "second.mjs");
    await writeFile(evil, "throw new Error('should-not-import')", { mode: 0o600 });
    const second = {
      manifest: { ...manifest, adapterId: "example.other.v1" },
      entrypoint: evil,
      sha256: "0".repeat(64),
    };
    await writeFile(catalog, JSON.stringify({
      schemaVersion: 1, adapters: [spec, second],
    }), { mode: 0o600 });
    await assert.rejects(
      loadApprovedSessionAdapters(catalog),
      { code: "entrypoint_digest_mismatch" },
    );
  });
});

test("catalog rejects unknown fields", async () => {
  await fixture(async ({ catalog, spec }) => {
    await writeFile(catalog, JSON.stringify({
      schemaVersion: 1, adapters: [{ ...spec, arbitrary: true }],
    }), { mode: 0o600 });
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "invalid_adapter_specification",
    });
  });
});

test("catalog rejects duplicate adapter identities", async () => {
  await fixture(async ({ catalog, spec }) => {
    await writeFile(catalog, JSON.stringify({
      schemaVersion: 1, adapters: [spec, spec],
    }), { mode: 0o600 });
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "duplicate_adapter_identity",
    });
  });
});

test("catalog rejects adapter factory that changes its pinned manifest", async () => {
  const mutated = source.replace("example.echo.streaming.v1", "example.other.v1");
  await fixture(async ({ catalog }) => {
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "adapter_contract_mismatch",
    });
  }, { code: mutated });
});

test("catalog rejects adapter without required functions", async () => {
  await fixture(async ({ catalog }) => {
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "create_adapter_export_required",
    });
  }, { code: "export const unrelated = true;" });
});

test("catalog rejects relative entrypoint", async () => {
  await fixture(async ({ catalog, spec }) => {
    await writeFile(catalog, JSON.stringify({
      schemaVersion: 1,
      adapters: [{ ...spec, entrypoint: "./relative.mjs" }],
    }), { mode: 0o600 });
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "invalid_entrypoint_or_digest",
    });
  });
});

test("catalog rejects leaf symlinks", async () => {
  await fixture(async ({ catalog, entrypoint, spec, dir }) => {
    const link = path.join(dir, "link.mjs");
    await symlink(entrypoint, link);
    await writeFile(catalog, JSON.stringify({
      schemaVersion: 1,
      adapters: [{ ...spec, entrypoint: link }],
    }), { mode: 0o600 });
    await assert.rejects(loadApprovedSessionAdapters(catalog));
  });
});

test("catalog rejects world-writable source files", async () => {
  if (process.platform === "win32") return;
  await fixture(async ({ catalog, entrypoint }) => {
    await chmod(entrypoint, 0o666);
    await assert.rejects(loadApprovedSessionAdapters(catalog), {
      code: "unsafe_file_owner_or_permissions",
    });
  });
});

test("configuration defaults to disabled and validates absolute catalog path", () => {
  const base = {
    GPULINK_WORKER_TOKEN: "a".repeat(32),
    GPULINK_WORKER_NAME: "dp3b-worker",
  };
  assert.equal(loadWorkerConfig(base).approvedAdapterCatalogPath, null);
  assert.equal(loadWorkerConfig({
    ...base, GPULINK_APPROVED_ADAPTERS_CATALOG_PATH: "/tmp/catalog.json",
  }).approvedAdapterCatalogPath, "/tmp/catalog.json");
  assert.throws(() => loadWorkerConfig({
    ...base, GPULINK_APPROVED_ADAPTERS_CATALOG_PATH: "./catalog.json",
  }), /absolute path/u);
});
