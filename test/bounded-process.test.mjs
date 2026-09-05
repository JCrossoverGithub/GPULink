import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedProcess } from "../src/worker/bounded-process.mjs";

const environment = { ...process.env };

test("bounded process launcher captures successful output without a shell", async () => {
  const result = await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdout.write('ok')"],
    { timeoutMs: 2_000, env: environment },
  );
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});

test("bounded process launcher does not inherit the worker environment by default", async () => {
  process.env.GPULINK_TEST_PARENT_SECRET = "must-not-leak";
  try {
    const result = await runBoundedProcess(
      process.execPath,
      ["-e", "process.stdout.write(process.env.GPULINK_TEST_PARENT_SECRET ?? 'absent')"],
      { timeoutMs: 2_000 },
    );
    assert.equal(result.stdout, "absent");
  } finally {
    delete process.env.GPULINK_TEST_PARENT_SECRET;
  }
});

test("bounded process launcher reports nonzero exits with bounded stderr", async () => {
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ["-e", "process.stderr.write('bounded failure'); process.exit(7)"],
      { timeoutMs: 2_000, env: environment },
    ),
    (error) => error.code === "process_runner_failed" && /bounded failure/u.test(error.message),
  );
});

test("bounded process launcher enforces timeout, cancellation, and combined output limits", async () => {
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 20, env: environment },
    ),
    (error) => error.code === "process_timeout",
  );

  const controller = new AbortController();
  const cancelled = runBoundedProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 2_000, env: environment, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, (error) => error.code === "job_aborted");

  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(60)); process.stderr.write('x'.repeat(60))"],
      { timeoutMs: 2_000, env: environment, maxOutputBytes: 100 },
    ),
    (error) => error.code === "process_output_limit",
  );
});

test("bounded process launcher rejects unsafe invocation metadata", () => {
  assert.throws(
    () => runBoundedProcess("node", [], { timeoutMs: 1_000 }),
    /executable must be an absolute path/u,
  );
  assert.throws(
    () => runBoundedProcess(process.execPath, ["valid", 42], { timeoutMs: 1_000 }),
    /arguments must be an array/u,
  );
  assert.throws(
    () => runBoundedProcess(process.execPath, [], { timeoutMs: 0 }),
    /timeout must be between/u,
  );
  assert.throws(
    () => runBoundedProcess(process.execPath, [], { maxOutputBytes: 0 }),
    /output limit must be between/u,
  );
});
