import { execFile } from "node:child_process";

const adapters = new Map([
  ["diagnostic.echo", runDiagnosticEcho],
  ["diagnostic.gpu-status", runGpuStatus],
]);

const gpuStatusFields = [
  "uuid",
  "name",
  "driver_version",
  "memory.total",
  "memory.used",
  "utilization.gpu",
  "temperature.gpu",
  "power.draw",
  "clocks.current.graphics",
  "clocks.current.memory",
];

export function hasAdapter(type) {
  return adapters.has(type);
}

export async function executeJob(job, { signal }) {
  const adapter = adapters.get(job.type);
  if (!adapter) {
    const error = new Error(`No installed adapter for workload type ${job.type}`);
    error.code = "adapter_not_installed";
    throw error;
  }
  return adapter(job, signal);
}

async function runDiagnosticEcho(job, signal) {
  const payload = job.payload;
  const durationMs = Number.isSafeInteger(payload.durationMs)
    ? Math.min(Math.max(payload.durationMs, 0), 10_000)
    : 0;
  if (durationMs > 0) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("job aborted"));
      }, { once: true });
    });
  }
  return { echo: payload.echo ?? null, completedAt: Date.now() };
}

async function runGpuStatus(job, signal) {
  const stdout = await runCommand("nvidia-smi", [
    "-i",
    job.assignedGpuUuid,
    `--query-gpu=${gpuStatusFields.join(",")}`,
    "--format=csv,noheader,nounits",
  ], signal);
  return parseGpuStatusOutput(stdout);
}

export function parseGpuStatusOutput(stdout) {
  const values = stdout.trim().split(",").map((value) => value.trim());
  if (values.length !== gpuStatusFields.length) {
    const error = new Error("nvidia-smi returned an unexpected diagnostic response");
    error.code = "gpu_diagnostic_invalid";
    throw error;
  }
  return {
    gpu: {
      uuid: values[0],
      name: values[1],
      driverVersion: values[2],
      memoryTotalMiB: requiredNumber(values[3], "memory.total"),
      memoryUsedMiB: requiredNumber(values[4], "memory.used"),
      utilizationPercent: requiredNumber(values[5], "utilization.gpu"),
      temperatureC: requiredNumber(values[6], "temperature.gpu"),
      powerDrawWatts: optionalNumber(values[7]),
      graphicsClockMHz: requiredNumber(values[8], "clocks.current.graphics"),
      memoryClockMHz: requiredNumber(values[9], "clocks.current.memory"),
    },
    checkedAt: Date.now(),
  };
}

function runCommand(command, arguments_, signal) {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
      signal,
    }, (error, stdout) => {
      if (error) {
        error.code = signal.aborted ? "job_aborted" : "gpu_diagnostic_failed";
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function requiredNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const error = new Error(`nvidia-smi returned invalid ${name}`);
    error.code = "gpu_diagnostic_invalid";
    throw error;
  }
  return parsed;
}

function optionalNumber(value) {
  return value === "N/A" || value === "[N/A]" ? null : requiredNumber(value, "optional field");
}
