import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QUERY_FIELDS = [
  "index",
  "uuid",
  "name",
  "memory.total",
  "memory.used",
  "utilization.gpu",
  "temperature.gpu",
  "power.draw",
];

// Messages are constructed exclusively from fixed diagnostic text and known field names.
// Keep raw subprocess errors in cause, not in operator-facing diagnostics.
export class GPUInventoryError extends Error {}

export async function discoverGpus({ fakeGpus = null } = {}) {
  if (fakeGpus !== null) return structuredClone(fakeGpus);
  let stdout;
  try {
    ({ stdout } = await execFileAsync("nvidia-smi", [
      `--query-gpu=${QUERY_FIELDS.join(",")}`,
      "--format=csv,noheader,nounits",
    ], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_048_576,
    }));
  } catch (error) {
    throw new GPUInventoryError(error.killed ? "nvidia-smi timed out" : "nvidia-smi execution failed", { cause: error });
  }

  return parseNvidiaSmiInventory(stdout);
}

export function parseNvidiaSmiInventory(stdout) {
  return stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const columns = line.split(",").map((value) => value.trim());
    if (columns.length !== QUERY_FIELDS.length) {
      throw new GPUInventoryError("Unexpected nvidia-smi inventory column count");
    }
    return {
      index: parseInteger(columns[0], "index"),
      uuid: columns[1],
      name: columns[2],
      memoryTotalMiB: parseInteger(columns[3], "memory.total"),
      memoryUsedMiB: parseInteger(columns[4], "memory.used"),
      utilizationPercent: parseInteger(columns[5], "utilization.gpu"),
      temperatureC: parseTemperature(columns[6]),
      powerDrawWatts: parseOptionalNumber(columns[7]),
    };
  });
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new GPUInventoryError(`Invalid ${name} value from nvidia-smi`);
  return parsed;
}

function parseTemperature(value) {
  // Some drivers report fractional Celsius. The registration/heartbeat contract
  // requires whole degrees in [0, 200]; normalize only after validating the reading.
  const parsed = Number(value);
  if (!/^\d+(?:\.\d+)?$/u.test(value) || !Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
    throw new GPUInventoryError("Invalid temperature.gpu value from nvidia-smi");
  }
  return Math.round(parsed);
}

function parseOptionalNumber(value) {
  if (value === "[N/A]" || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
