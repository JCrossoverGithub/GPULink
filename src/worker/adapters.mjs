import { execFile } from "node:child_process";
import {
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  validateAdapterManifest,
} from "../shared/adapter-manifest.mjs";
import { adapterHealthReport } from "../shared/adapter-health.mjs";
import { BENCHMARK_TYPE } from "../shared/benchmark-contract.mjs";
import { probeBenchmarkRuntime, runGpuBenchmark } from "./gpu-benchmark.mjs";

const adapters = new Map([
  defineAdapter({
    type: "diagnostic.echo",
    version: "1.0.0",
    executionMode: "in-process",
    execute: runDiagnosticEcho,
  }),
  defineAdapter({
    type: "diagnostic.gpu-status",
    version: "1.0.0",
    executionMode: "in-process",
    execute: runGpuStatus,
  }),
  defineAdapter({
    type: BENCHMARK_TYPE,
    version: "1.0.0",
    executionMode: "bounded-process",
    execute: runGpuBenchmark,
    readinessProbe: ({ benchmark, gpus, runProcess, fileAccess }) =>
      probeBenchmarkRuntime({
        benchmark,
        gpu: gpus?.[0],
        runProcess,
        fileAccess,
      }),
  }),
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

export async function executeJob(job, context) {
  const adapter = adapters.get(job.type);
  if (!adapter) {
    const error = new Error(`No installed adapter for workload type ${job.type}`);
    error.code = "adapter_not_installed";
    throw error;
  }
  return adapter.execute(job, context);
}

export async function resolveAvailableCapabilities(capabilities, context = {}) {
  return (await resolveAdapterHealth(capabilities, context)).capabilities;
}

export async function resolveAdapterHealth(
  configuredCapabilities,
  context = {},
  checkedAt = Date.now(),
) {
  const capabilities = [];
  const adapterManifests = [];
  const adapterHealth = [];
  for (const capability of [...new Set(configuredCapabilities)].sort()) {
    const adapter = adapters.get(capability);
    if (!adapter) {
      adapterHealth.push(adapterHealthReport(capability, "not-installed", checkedAt));
      continue;
    }
    let ready = false;
    try {
      ready = await adapter.readinessProbe(context) === true;
    } catch {
      // Raw probe errors remain local and are reduced to a bounded status code.
    }
    if (ready) {
      capabilities.push(capability);
      adapterManifests.push(adapter.manifest);
      adapterHealth.push(adapterHealthReport(capability, "ready", checkedAt));
    } else {
      adapterHealth.push(adapterHealthReport(capability, "unavailable", checkedAt));
    }
  }
  return Object.freeze({ capabilities, adapterManifests, adapterHealth });
}

export function listAdapterManifests(capabilities) {
  return capabilities
    .map((capability) => adapters.get(capability)?.manifest)
    .filter((manifest) => manifest !== undefined);
}

function defineAdapter({ type, version, executionMode, execute, readinessProbe }) {
  const manifest = validateAdapterManifest({
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    type,
    version,
    executionMode,
  });
  if (typeof execute !== "function") throw new TypeError(`${type} execute must be a function`);
  if (readinessProbe !== undefined && typeof readinessProbe !== "function") {
    throw new TypeError(`${type} readinessProbe must be a function`);
  }
  return [type, Object.freeze({
    manifest,
    execute,
    readinessProbe: readinessProbe ?? (() => true),
  })];
}

async function runDiagnosticEcho(job, { signal }) {
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

async function runGpuStatus(job, { signal }) {
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
