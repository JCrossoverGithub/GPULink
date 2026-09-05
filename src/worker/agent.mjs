import { ControlPlaneClient } from "./control-plane-client.mjs";
import { discoverGpus } from "./gpu-inventory.mjs";
import { discoverModelInventory } from "./model-cache.mjs";
import {
  executeJob,
  hasAdapter,
  resolveAdapterHealth,
} from "./adapters.mjs";

export class WorkerAgent {
  constructor(config, options = {}) {
    this.config = config;
    this.client = options.client ?? new ControlPlaneClient(config.controlPlaneUrl, config.token);
    this.discoverGpus = options.discoverGpus ?? (() => discoverGpus({ fakeGpus: config.fakeGpus }));
    this.executeJob = options.executeJob ?? executeJob;
    this.resolveAdapterHealth = options.resolveAdapterHealth ?? resolveAdapterHealth;
    this.discoverModelInventory = options.discoverModelInventory ?? (() =>
      discoverModelInventory({
        manifestPath: config.modelCache?.manifestPath ?? "/var/lib/gpulink/models/manifest.json",
        cacheRoot: config.modelCache?.rootPath ?? "/var/lib/gpulink/models",
      }));
    this.adapterContext = options.adapterContext ?? {};
    this.workerId = null;
    this.gpus = [];
    this.capabilities = [];
    this.adapterManifests = [];
    this.adapterHealth = [];
    this.modelInventory = [];
    this.capabilitiesCheckedAt = 0;
    this.modelInventoryCheckedAt = 0;
    this.running = false;
    this.heartbeatTimer = null;
    this.assignmentTimer = null;
    this.inFlight = new Map();
    this.pendingOperations = new Set();
  }

  async start() {
    if (this.running) return;
    const gpus = await this.discoverGpus();
    this.gpus = gpus;
    await this.#refreshCapabilities(true);
    await this.#refreshModelInventory(true);
    const response = await this.client.registerWorker({
      name: this.config.name,
      version: this.config.version,
      labels: this.config.labels,
      capabilities: this.capabilities,
      adapterManifests: this.adapterManifests,
      adapterHealth: this.adapterHealth,
      warmModels: this.config.warmModels,
      modelInventory: this.modelInventory,
      gpus,
    });
    this.workerId = response.worker.id;
    this.running = true;
    console.log(JSON.stringify({
      event: "worker_registered",
      workerId: this.workerId,
      name: this.config.name,
      gpuCount: gpus.length,
    }));
    this.#scheduleHeartbeat();
    this.#scheduleAssignmentPoll();
  }

  async stop() {
    this.running = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.assignmentTimer) clearTimeout(this.assignmentTimer);
    await Promise.allSettled(this.pendingOperations);
    await Promise.allSettled([...this.inFlight.values()].map((entry) => {
      entry.controller.abort(new Error("worker stopping"));
      return entry.promise;
    }));
  }

  #scheduleHeartbeat() {
    this.heartbeatTimer = setTimeout(() => {
      if (!this.running) return;
      const operation = (async () => {
        try {
          const gpus = await this.discoverGpus();
          this.gpus = gpus;
          await this.#refreshCapabilities(false);
          await this.#refreshModelInventory(false);
          await this.client.heartbeat(this.workerId, {
            capabilities: this.capabilities,
            adapterManifests: this.adapterManifests,
            adapterHealth: this.adapterHealth,
            warmModels: this.config.warmModels,
            modelInventory: this.modelInventory,
            gpus,
          });
        } catch (error) {
          console.error(JSON.stringify({ event: "heartbeat_failed", message: error.message }));
        } finally {
          if (this.running) this.#scheduleHeartbeat();
        }
      })();
      this.#trackOperation(operation);
    }, this.config.heartbeatIntervalMs);
  }

  #scheduleAssignmentPoll() {
    this.assignmentTimer = setTimeout(() => {
      if (!this.running) return;
      const operation = (async () => {
        try {
          const response = await this.client.leases(this.workerId);
          const activeJobIds = new Set(response.jobs.map((job) => job.id));
          for (const [jobId, entry] of this.inFlight) {
            if (!activeJobIds.has(jobId)) {
              entry.controller.abort(new Error("job lease is no longer active"));
            }
          }
          for (const job of response.jobs) {
            if (job.status === "leased" && !this.inFlight.has(job.id)) {
              this.#runJob(job);
            }
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "assignment_poll_failed", message: error.message }));
        } finally {
          if (this.running) this.#scheduleAssignmentPoll();
        }
      })();
      this.#trackOperation(operation);
    }, this.config.assignmentIntervalMs);
  }

  #trackOperation(operation) {
    this.pendingOperations.add(operation);
    operation.finally(() => this.pendingOperations.delete(operation));
  }

  async #refreshCapabilities(force) {
    const now = Date.now();
    const intervalMs = this.config.capabilityProbeIntervalMs ?? 300_000;
    if (!force && now - this.capabilitiesCheckedAt < intervalMs) return;
    const report = await this.resolveAdapterHealth(this.config.capabilities, {
      ...this.adapterContext,
      benchmark: this.config.benchmark,
      gpus: this.gpus,
    }, now);
    this.capabilities = report.capabilities;
    this.adapterManifests = report.adapterManifests;
    this.adapterHealth = report.adapterHealth;
    this.capabilitiesCheckedAt = now;
  }

  async #refreshModelInventory(force) {
    const now = Date.now();
    const intervalMs = this.config.modelInventoryIntervalMs ?? 300_000;
    if (!force && now - this.modelInventoryCheckedAt < intervalMs) return;
    try {
      this.modelInventory = await this.discoverModelInventory();
    } catch (error) {
      this.modelInventory = [];
      console.error(JSON.stringify({
        event: "model_inventory_failed",
        code: error.code ?? "model_cache_manifest_invalid",
      }));
    } finally {
      this.modelInventoryCheckedAt = now;
    }
  }

  #runJob(job) {
    const controller = new AbortController();
    const promise = this.#executeLease(job, controller.signal)
      .catch((error) => console.error(JSON.stringify({
        event: "job_execution_reporting_failed",
        jobId: job.id,
        message: error.message,
      })))
      .finally(() => this.inFlight.delete(job.id));
    this.inFlight.set(job.id, { controller, promise });
  }

  async #executeLease(job, signal) {
    const lease = { workerId: this.workerId, leaseId: job.leaseId };
    await this.client.startJob(job.id, lease);
    console.log(JSON.stringify({ event: "job_started", jobId: job.id, type: job.type }));

    if (!hasAdapter(job.type)) {
      await this.client.finishJob(job.id, {
        ...lease,
        outcome: "failed",
        error: { code: "adapter_not_installed", message: `No adapter installed for ${job.type}` },
      });
      return;
    }

    const reportedLeaseRemainingMs = job.leaseExpiresAt - Date.now();
    const renewIntervalMs = Math.max(
      1_000,
      Math.min(
        this.config.heartbeatIntervalMs,
        Math.floor(reportedLeaseRemainingMs / 3),
      ),
    );
    const renewTimer = setInterval(() => {
      this.client.renewJob(job.id, lease).catch((error) => {
        console.error(JSON.stringify({ event: "lease_renewal_failed", jobId: job.id, message: error.message }));
      });
    }, renewIntervalMs);

    try {
      const gpu = this.gpus.find((candidate) => candidate.uuid === job.assignedGpuUuid) ?? null;
      const result = await this.executeJob(job, {
        ...this.adapterContext,
        signal,
        gpu,
        benchmark: this.config.benchmark,
      });
      await this.client.finishJob(job.id, { ...lease, outcome: "succeeded", result });
      console.log(JSON.stringify({ event: "job_succeeded", jobId: job.id }));
    } catch (error) {
      try {
        await this.client.finishJob(job.id, {
          ...lease,
          outcome: "failed",
          error: { code: error.code || "adapter_failed", message: error.message },
        });
      } catch (reportingError) {
        if (reportingError.statusCode !== 409) throw reportingError;
      }
    } finally {
      clearInterval(renewTimer);
    }
  }
}
