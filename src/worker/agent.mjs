import { setTimeout as delay } from "node:timers/promises";

import {
  WebSocket,
} from "ws";

import {
  createDataPlaneProtocols,
  DATA_PLANE_MAX_FRAME_BYTES,
  DATA_PLANE_PATH,
} from "../shared/data-plane-contract.mjs";

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
    this.sessionLeaseHandler =
      options.sessionLeaseHandler ??
      null;
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

          const activeJobIds =
            new Set(
              response.jobs
                .map((job) => job.id),
            );

          for (
            const [jobId, entry]
            of this.inFlight
          ) {
            if (
              !activeJobIds.has(
                jobId,
              )
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

          if (
            this.sessionLeaseHandler
          ) {
            for (
              const session
              of response.sessions ?? []
            ) {
              if (
                session.status ===
                  "allocated" &&
                !this.sessionLeases.has(
                  session.id,
                )
              ) {
                this.#runSession(
                  session,
                );
              }
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

  #runSession(session) {
    const controller =
      new AbortController();

    const promise =
      this.#maintainSessionLease(
        session,
        controller,
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
        this.sessionLeaseHandler(
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
