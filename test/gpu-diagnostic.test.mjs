import assert from "node:assert/strict";
import test from "node:test";
import { parseGpuStatusOutput } from "../src/worker/adapters.mjs";

test("parses a complete nvidia-smi diagnostic row", () => {
  const result = parseGpuStatusOutput(
    "GPU-123, NVIDIA GeForce RTX 4060, 572.83, 8188, 1024, 17, 52, 31.25, 2100, 8001\n",
  );

  assert.deepEqual(result.gpu, {
    uuid: "GPU-123",
    name: "NVIDIA GeForce RTX 4060",
    driverVersion: "572.83",
    memoryTotalMiB: 8188,
    memoryUsedMiB: 1024,
    utilizationPercent: 17,
    temperatureC: 52,
    powerDrawWatts: 31.25,
    graphicsClockMHz: 2100,
    memoryClockMHz: 8001,
  });
  assert.equal(Number.isSafeInteger(result.checkedAt), true);
});

test("accepts an unavailable power reading", () => {
  const result = parseGpuStatusOutput(
    "GPU-456, NVIDIA GeForce RTX 3070 Ti, 572.83, 8192, 256, 0, 41, [N/A], 210, 405\n",
  );

  assert.equal(result.gpu.powerDrawWatts, null);
});

test("rejects malformed diagnostic output", () => {
  assert.throws(
    () => parseGpuStatusOutput("GPU-123, NVIDIA GPU\n"),
    (error) => error.code === "gpu_diagnostic_invalid",
  );
});
