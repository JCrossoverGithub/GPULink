import assert from "node:assert/strict";
import test from "node:test";
import { discoverGpus, parseNvidiaSmiInventory, GPUInventoryError } from "../src/worker/gpu-inventory.mjs";

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

const row = (temperature, power = "39.58") =>
  `0, GPU-TEST, NVIDIA GeForce RTX 3090 Ti, 24564, 2008, 21, ${temperature}, ${power}`;

test("fractional driver temperature is rounded to the integer registration contract", () => {
  assert.deepEqual(parseNvidiaSmiInventory(row("51.70")), [{
    index: 0, uuid: "GPU-TEST", name: "NVIDIA GeForce RTX 3090 Ti",
    memoryTotalMiB: 24564, memoryUsedMiB: 2008, utilizationPercent: 21,
    temperatureC: 52, powerDrawWatts: 39.58,
  }]);
  for (const [input, expected] of [["51", 51], ["51.49", 51], ["51.50", 52], ["0.00", 0], ["199.99", 200], ["200", 200]]) {
    assert.equal(parseNvidiaSmiInventory(row(input))[0].temperatureC, expected);
  }
  assert.equal(parseNvidiaSmiInventory(row("52", "[N/A]"))[0].powerDrawWatts, null);
});

test("invalid temperature is rejected before rounding, without leaking raw input", () => {
  for (const value of ["", "N/A", "[N/A]", "NaN", "Infinity", "-0.1", "200.1", "0x32", "5e1", "secret-untrusted-output"]) {
    assert.throws(() => parseNvidiaSmiInventory(row(value)), {
      name: "Error", message: "Invalid temperature.gpu value from nvidia-smi",
    });
  }
  assert.throws(() => parseNvidiaSmiInventory("malformed secret-untrusted-output"), error =>
    error instanceof GPUInventoryError && !error.message.includes("secret-untrusted-output"));
});

test("integer memory and utilization requirements remain unchanged", () => {
  assert.throws(() => parseNvidiaSmiInventory(row("51.70").replace("24564", "24564.5")), /Invalid memory.total/u);
  assert.throws(() => parseNvidiaSmiInventory(row("51.70").replace(", 21,", ", 21.5,")), /Invalid utilization.gpu/u);
});
