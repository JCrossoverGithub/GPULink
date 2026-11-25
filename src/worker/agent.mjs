import { setTimeout as delay } from "node:timers/promises";

import {
  WebSocket,
} from "ws";

import {
  createDataPlaneProtocols,
  DATA_PLANE_MAX_FRAME_BYTES,
  DATA_PLANE_PATH,
} from "../shared/data-plane-contract.mjs";

import { createJobLeaseGuard } from "./job-lease-guard.mjs";
import { ControlPlaneClient } from "./control-plane-client.mjs";
import { discoverGpus } from "./gpu-inventory.mjs";
import { discoverModelInventory } from "./model-cache.mjs";

import {
  createSessionAdapterRegistry,
  probeSessionAdapters,
  selectSessionHandler,
} from "./session-adapters.mjs";
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
    this.sessionLeaseHandler =
      options.sessionLeaseHandler ??
      null;

    this.sessionAdapters = createSessionAdapterRegistry(
      options.sessionAdapters ?? [],
    );

    this.readySessionAdapters = new Set();
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
    this.sessionLeases =
      new Map();
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

    await Promise.allSettled(
      [...this.sessionLeases.values()]
        .map((entry) => {
          entry.controller.abort(
            new Error(
              "worker stopping",
            ),
          );

          return entry.promise;
        }),
    );
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

          const activeJobIds = new Map(response.jobs.map(job => [job.id,job.leaseId]));

          for (
            const [jobId, entry]
            of this.inFlight
          ) {
            if (
              !activeJobIds.has(jobId) || activeJobIds.get(jobId) !== entry.leaseId
            ) {
              entry.controller.abort(
                new Error(
                  "job lease is no longer active",
                ),
              );
            }
          }

          for (const job of response.jobs) {
            if (
              job.status === "leased" &&
              !this.inFlight.has(
                job.id,
              )
            ) {
              this.#runJob(job);
            }
          }

          const sessionsById =
            new Map(
              (response.sessions ?? [])
                .map(
                  (session) => [
                    session.id,
                    session,
                  ],
                ),
            );

          for (
            const [
              sessionId,
              entry,
            ]
            of this.sessionLeases
          ) {
            const current =
              sessionsById.get(
                sessionId,
              );

            if (
              !current ||
              current.leaseId !==
                entry.leaseId
            ) {
              entry.controller.abort(
                new Error(
                  "session lease is no longer active",
                ),
              );
            }
          }

          for (const session of response.sessions ?? []) {
            if (
              session.status !== "allocated" ||
              this.sessionLeases.has(session.id)
            ) {
              continue;
            }

            const handler = selectSessionHandler({
              session,
              registry: this.sessionAdapters,
              readyIds: this.readySessionAdapters,
              legacyHandler: this.sessionLeaseHandler,
            });

            if (handler) {
              this.#runSession(session, handler);
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
    // Generic health resolvers cannot certify v2 handlers.
    const v1Manifests = report.adapterManifests.filter(
      (manifest) => manifest.schemaVersion === 1,
    );

    const v1Types = new Set(
      v1Manifests.map((manifest) => manifest.type),
    );

    const sessionTypes = new Set(
      [...this.sessionAdapters.values()].map(
        (adapter) => adapter.manifest.type,
      ),
    );

    for (const type of v1Types) {
      if (sessionTypes.has(type)) {
        throw new Error(
          `session adapter conflicts with v1 capability ${type}`,
        );
      }
    }

    const sessionReport = await probeSessionAdapters(
      this.sessionAdapters,
      {
        ...this.adapterContext,
        gpus: this.gpus,
      },
      now,
    );

    const v1Capabilities = report.capabilities.filter(
      (capability) => v1Types.has(capability),
    );

    const v1Health = report.adapterHealth.filter(
      (health) =>
        health.schemaVersion === 1 &&
        !sessionTypes.has(health.type),
    );

    this.capabilities = [
      ...new Set([
        ...v1Capabilities,
        ...sessionReport.capabilities,
      ]),
    ].sort();

    this.adapterManifests = [
      ...v1Manifests,
      ...sessionReport.adapterManifests,
    ];

    this.adapterHealth = [
      ...v1Health,
      ...sessionReport.adapterHealth,
    ];

    this.readySessionAdapters = new Set(
      sessionReport.adapterHealth
        .filter((entry) => entry.state === "ready")
        .map((entry) => entry.adapterId),
    );

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

  #runSession(session, handler) {
    const controller =
      new AbortController();

    const promise =
        this.#maintainSessionLease(
          session,
          controller,
          handler,
        )
        .catch((error) => {
          if (
            !controller.signal
              .aborted
          ) {
            console.error(
              JSON.stringify({
                event:
                  "session_lease_failed",
                sessionId:
                  session.id,
                message:
                  error.message,
              }),
            );
          }
        })
        .finally(() => {
          this.sessionLeases
            .delete(
              session.id,
            );
        });

    this.sessionLeases.set(
      session.id,
      {
        controller,
        promise,
        leaseId:
          session.leaseId,
      },
    );
  }

  async #maintainSessionLease(
    session,
    controller,
    handler,
  ) {
    const signal =
      controller.signal;

    const lease = {
      workerId:
        this.workerId,
      leaseId:
        session.leaseId,
    };

    const startResponse =
      await this.client
        .startSession(
          session.id,
          lease,
        );

    const connecting =
      startResponse.session;

    console.log(
      JSON.stringify({
        event:
          "session_connecting",
        sessionId:
          session.id,
        capability:
          session.capability,
      }),
    );

    const gpu =
      this.gpus.find(
        (candidate) =>
          candidate.uuid ===
          connecting
            .assignedGpuUuid,
      ) ??
      null;

    const dataPlane =
      await this
        .#openSessionDataPlane(
          connecting,
          lease,
          signal,
        );

    console.log(
      JSON.stringify({
        event:
          "session_data_plane_connected",
        sessionId:
          session.id,
        capability:
          session.capability,
      }),
    );

    const handlerPromise =
      Promise.resolve(
        handler(
          connecting,
          {
            ...this.adapterContext,
            signal,
            gpu,
            dataPlaneSocket:
              dataPlane.socket,
          },
        ),
      );

    const renewalPromise =
      this.#renewSessionLease(
        connecting,
        lease,
        controller,
      );

    try {
      const completed =
        await Promise.race([
          handlerPromise.then(
            () => "handler",
          ),
          renewalPromise.then(
            () => "renewal",
          ),
          dataPlane.closed.then(
            () => "data-plane",
          ),
        ]);

      if (
        !signal.aborted
      ) {
        controller.abort(
          new Error(
            completed ===
              "handler"
              ? "session handler stopped"
              : completed ===
                  "renewal"
                ? "session lease renewal stopped"
                : "session data plane closed",
          ),
        );
      }
    } catch (error) {
      if (
        !signal.aborted
      ) {
        controller.abort(
          error,
        );
      }

      throw error;
    } finally {
      dataPlane.close();

      await Promise.allSettled([
        handlerPromise,
        renewalPromise,
      ]);
    }
  }

  async #openSessionDataPlane(
    session,
    lease,
    signal,
  ) {
    const grantResponse =
      await this.client
        .workerDataPlaneGrant(
          session.id,
          lease,
        );

    const grant =
      grantResponse?.grant;

    if (
      !grant ||
      typeof grant.token !==
        "string"
    ) {
      throw new Error(
        "control plane did not return a worker data-plane grant",
      );
    }

    const url =
      new URL(
        this.config
          .controlPlaneUrl,
      );

    if (
      url.protocol ===
      "http:"
    ) {
      url.protocol =
        "ws:";
    } else if (
      url.protocol ===
      "https:"
    ) {
      url.protocol =
        "wss:";
    } else {
      throw new Error(
        "control-plane URL must use http or https for data-plane relay",
      );
    }

    url.pathname =
      DATA_PLANE_PATH;

    url.search = "";
    url.hash = "";

    const socket =
      new WebSocket(
        url,
        createDataPlaneProtocols(
          grant.token,
        ),
        {
          maxPayload:
            DATA_PLANE_MAX_FRAME_BYTES,
          perMessageDeflate:
            false,
          handshakeTimeout:
            10_000,
        },
      );

    let resolveClosed;

    const closed =
      new Promise(
        (resolve) => {
          resolveClosed =
            resolve;
        },
      );

    socket.once(
      "close",
      (
        code,
        reason,
      ) => {
        resolveClosed({
          code,
          reason:
            reason.toString(),
        });
      },
    );

    const abortSocket =
      () => {
        if (
          socket.readyState ===
            WebSocket.CLOSED
        ) {
          return;
        }

        if (
          socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
            socket.close(
              1000,
              "worker session stopped",
            );

            return;
          } catch {
            // Fall through to terminate.
          }
        }

        socket.terminate();
      };

    signal.addEventListener(
      "abort",
      abortSocket,
      {
        once: true,
      },
    );

    try {
      await new Promise(
        (
          resolve,
          reject,
        ) => {
          if (
            signal.aborted
          ) {
            reject(
              signal.reason ??
              new Error(
                "session aborted before data-plane connection",
              ),
            );

            return;
          }

          const onOpen =
            () => {
              cleanup();
              resolve();
            };

          const onError =
            (error) => {
              cleanup();
              reject(
                error,
              );
            };

          const onClose =
            (
              code,
              reason,
            ) => {
              cleanup();

              reject(
                new Error(
                  `data-plane connection closed before open (${code}: ${reason.toString()})`,
                ),
              );
            };

          const onAbort =
            () => {
              cleanup();

              reject(
                signal.reason ??
                new Error(
                  "session aborted before data-plane connection",
                ),
              );
            };

          const cleanup =
            () => {
              socket.off(
                "open",
                onOpen,
              );

              socket.off(
                "error",
                onError,
              );

              socket.off(
                "close",
                onClose,
              );

              signal
                .removeEventListener(
                  "abort",
                  onAbort,
                );
            };

          socket.once(
            "open",
            onOpen,
          );

          socket.once(
            "error",
            onError,
          );

          socket.once(
            "close",
            onClose,
          );

          signal
            .addEventListener(
              "abort",
              onAbort,
              {
                once: true,
              },
            );
        },
      );
    } catch (error) {
      abortSocket();

      await closed.catch(
        () => {},
      );

      throw error;
    }

    return {
      socket,
      closed,

      close() {
        signal
          .removeEventListener(
            "abort",
            abortSocket,
          );

        if (
          socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
            socket.close(
              1000,
              "worker session stopped",
            );
          } catch {
            socket.terminate();
          }
        } else if (
          socket.readyState !==
            WebSocket.CLOSED
        ) {
          socket.terminate();
        }

        /*
         * Keep the promise referenced so socket close
         * completion remains observable to callers.
         */
        void resolveClosed;
      },
    };
  }

  async #renewSessionLease(
    session,
    lease,
    controller,
  ) {
    const signal =
      controller.signal;

    let leaseExpiresAt =
      session.leaseExpiresAt;

    while (!signal.aborted) {
      const remainingMs =
        Math.max(
          1,
          leaseExpiresAt -
            Date.now(),
        );

      const renewDelayMs =
        Math.max(
          100,
          Math.min(
            this.config
              .heartbeatIntervalMs,
            Math.floor(
              remainingMs /
                3,
            ),
          ),
        );

      try {
        await delay(
          renewDelayMs,
          undefined,
          {
            signal,
          },
        );
      } catch (error) {
        if (
          signal.aborted ||
          error.name ===
            "AbortError"
        ) {
          return;
        }

        throw error;
      }

      if (signal.aborted) {
        return;
      }

      try {
        const response =
          await this.client
            .renewSession(
              session.id,
              lease,
            );

        leaseExpiresAt =
          response.session
            .leaseExpiresAt;
      } catch (error) {
        if (
          error.statusCode ===
            409
        ) {
          return;
        }

        console.error(
          JSON.stringify({
            event:
              "session_lease_renewal_failed",
            sessionId:
              session.id,
            message:
              error.message,
          }),
        );
      }
    }
  }

  #runJob(job) {
    const controller = new AbortController();
    const promise = this.#executeLease(job, controller)
      .catch((error) => console.error(JSON.stringify({
        event: "job_execution_reporting_failed",
        jobId: job.id,
        message: error.message,
      })))
      .finally(() => this.inFlight.delete(job.id));
    this.inFlight.set(job.id, { controller, promise, leaseId: job.leaseId });
  }

  async #executeLease(job, controller) {
    const {signal} = controller;
    const lease = { workerId: this.workerId, leaseId: job.leaseId };
    const requestedAt = performance.now();
    const started = await this.client.startJob(job.id, lease);
    if (signal.aborted) return;
    const guard = createJobLeaseGuard(controller, {jobId:job.id, ...lease});
    const remaining = guard.arm(started, requestedAt);
    if (!remaining) { guard.close(); return; }
    console.log(JSON.stringify({ event: "job_started", jobId: job.id, type: job.type }));

    if (!hasAdapter(job.type)) {
      try {
        if (guard.check()) await this.client.finishJob(job.id, {
          ...lease, outcome: "failed",
          error: { code: "adapter_not_installed", message: `No adapter installed for ${job.type}` },
        });
      } finally { guard.close(); }
      return;
    }

    let renewTimer;
    let done = false;
    const scheduleRenew = (duration) => {
      if (done || signal.aborted) return;
      const interval = Math.max(1, Math.min(this.config.heartbeatIntervalMs, Math.floor(duration / 3)));
      renewTimer = setTimeout(async () => {
        if (done || !guard.check()) return;
        const sentAt = performance.now();
        try {
          const renewed = await this.client.renewJob(job.id, lease);
          if (done) return;
          const remaining = guard.arm(renewed, sentAt);
          if (remaining) scheduleRenew(remaining);
        } catch (error) {
          if (done) return;
          console.error(JSON.stringify({ event: "lease_renewal_failed", jobId: job.id, message: error.message }));
          controller.abort(new Error("job lease renewal failed"));
        }
      }, interval);
    };
    scheduleRenew(remaining);

    try {
      const gpu = this.gpus.find((candidate) => candidate.uuid === job.assignedGpuUuid) ?? null;
      const result = await this.executeJob(job, {
        ...this.adapterContext,
        signal,
        gpu,
        benchmark: this.config.benchmark,
      });
      if (!guard.check()) return; // No cleanup attestation is inferred from an abort.
      await this.client.finishJob(job.id, { ...lease, outcome: "succeeded", result });
      console.log(JSON.stringify({ event: "job_succeeded", jobId: job.id }));
    } catch (error) {
      if (!guard.check()) return; // Server expires/quarantines; never release on uncertain cancellation.
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
      done = true;
      clearTimeout(renewTimer);
      guard.close();
    }
  }
}
