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
    throw new Error(`GPU discovery failed: ${error.message}`, { cause: error });
  }

  return stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const columns = line.split(",").map((value) => value.trim());
    if (columns.length !== QUERY_FIELDS.length) {
      throw new Error(`Unexpected nvidia-smi output: ${line}`);
    }
    return {
      index: parseInteger(columns[0], "index"),
      uuid: columns[1],
      name: columns[2],
      memoryTotalMiB: parseInteger(columns[3], "memory.total"),
      memoryUsedMiB: parseInteger(columns[4], "memory.used"),
      utilizationPercent: parseInteger(columns[5], "utilization.gpu"),
      temperatureC: parseInteger(columns[6], "temperature.gpu"),
      powerDrawWatts: parseOptionalNumber(columns[7]),
    };
  });
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name} value from nvidia-smi`);
  return parsed;
}

function parseOptionalNumber(value) {
  if (value === "[N/A]" || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
