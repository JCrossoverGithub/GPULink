import assert from "node:assert/strict";
import test from "node:test";
import { discoverGpus } from "../src/worker/gpu-inventory.mjs";

test("fake GPU inventory is copied and returned without nvidia-smi", async () => {
  const fake = [{
    uuid: "GPU-FAKE",
    index: 0,
    name: "Fake GPU",
    memoryTotalMiB: 24576,
    memoryUsedMiB: 100,
    utilizationPercent: 25,
    temperatureC: 50,
    powerDrawWatts: 125.5,
  }];
  const result = await discoverGpus({ fakeGpus: fake });
  assert.deepEqual(result, fake);
  assert.notEqual(result, fake);
});
