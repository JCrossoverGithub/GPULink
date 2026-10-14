import {
  URL,
} from "node:url";

import {
  WebSocket,
  WebSocketServer,
} from "ws";

import {
  DATA_PLANE_CLOSE_CODES,
  DATA_PLANE_IDLE_TIMEOUT_MS,
  DATA_PLANE_MAX_BUFFERED_BYTES,
  DATA_PLANE_MAX_FRAME_BYTES,
  DATA_PLANE_PATH,
  DATA_PLANE_PEER_WAIT_TIMEOUT_MS,
  DATA_PLANE_SUBPROTOCOL,
  DATA_PLANE_SUBPROTOCOL_V2,
  DATA_PLANE_RELAY_READY_V2,
  isDataPlaneBackpressured,
  parseDataPlaneProtocols,
  validateDataPlaneFrameSize,
} from "../shared/data-plane-contract.mjs";

export function createDataPlaneRelay({
  server,
  service,
  database,
  peerWaitTimeoutMs =
    DATA_PLANE_PEER_WAIT_TIMEOUT_MS,
  idleTimeoutMs =
    DATA_PLANE_IDLE_TIMEOUT_MS,
} = {}) {
  if (
    !server ||
    typeof server.on !== "function"
  ) {
    throw new TypeError(
      "data-plane relay requires an HTTP server",
    );
  }

  if (
    !service ||
    typeof service
      .authorizeDataPlaneGrant !==
      "function"
  ) {
    throw new TypeError(
      "data-plane relay requires a control-plane service",
    );
  }

  if (
    !database ||
    typeof database
      .subscribeToEvents !==
      "function"
  ) {
    throw new TypeError(
      "data-plane relay requires event-capable persistence",
    );
  }

  positiveSafeInteger(
    peerWaitTimeoutMs,
    "data-plane peer wait timeout",
  );

  positiveSafeInteger(
    idleTimeoutMs,
    "data-plane idle timeout",
  );

  const pairs =
    new Map();

  let closed =
    false;

  let unsubscribeEvents =
    null;

  let revalidationPromise =
    null;

  let revalidationPending =
    false;

  const webSocketServer =
    new WebSocketServer({
      noServer: true,
      clientTracking: true,
      maxPayload:
        DATA_PLANE_MAX_FRAME_BYTES,
      perMessageDeflate: false,

      handleProtocols(
        protocols,
      ) {
        return protocols.has(
          DATA_PLANE_SUBPROTOCOL_V2,
        )
          ? DATA_PLANE_SUBPROTOCOL_V2
          : protocols.has(
              DATA_PLANE_SUBPROTOCOL,
            )
            ? DATA_PLANE_SUBPROTOCOL
            : false;
      },
    });

  const onUpgrade =
    (
      request,
      socket,
      head,
    ) => {
      void handleUpgrade(
        request,
        socket,
        head,
      );
    };

  server.on(
    "upgrade",
    onUpgrade,
  );

  async function handleUpgrade(
    request,
    socket,
    head,
  ) {
    if (closed) {
      rejectUpgrade(
        socket,
        503,
        "relay unavailable",
      );

      return;
    }

    let url;

    try {
      url =
        new URL(
          request.url,
          "http://gpulink.local",
        );
    } catch {
      rejectUpgrade(
        socket,
        400,
        "invalid request URL",
      );

      return;
    }

    if (
      url.pathname !==
        DATA_PLANE_PATH ||
      url.search !== ""
    ) {
      rejectUpgrade(
        socket,
        404,
        "data-plane route not found",
      );

      return;
    }

    const protocolOffer =
      parseDataPlaneProtocols(
        request.headers[
          "sec-websocket-protocol"
        ],
      );

    if (!protocolOffer) {
      rejectUpgrade(
        socket,
        401,
        "valid data-plane grant required",
      );

      return;
    }

    const authorization =
      await authorizeGrant(
        service,
        protocolOffer.grant,
      ).catch(
        () => null,
      );

    if (!authorization) {
      rejectUpgrade(
        socket,
        401,
        "valid data-plane grant required",
      );

      return;
    }

    if (
      closed ||
      socket.destroyed
    ) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(
      request,
      socket,
      head,
      (webSocket) => {
        acceptConnection(
          webSocket,
          protocolOffer.grant,
          authorization,
          protocolOffer.protocol,
        );
      },
    );
  }

  async function start() {
    if (
      closed
    ) {
      throw new Error(
        "data-plane relay is closed",
      );
    }

    if (
      unsubscribeEvents
    ) {
      return;
    }

    unsubscribeEvents =
      await database
        .subscribeToEvents(
          () => {
            scheduleRevalidation();
          },
        );
  }

  function scheduleRevalidation() {
    if (
      closed
    ) {
      return;
    }

    if (
      revalidationPromise
    ) {
      revalidationPending =
        true;

      return;
    }

    revalidationPromise =
      revalidatePairs()
        .catch(
          (error) => {
            console.error(
              JSON.stringify({
                event:
                  "data_plane_revalidation_failed",
                message:
                  error.message,
              }),
            );
          },
        )
        .finally(
          () => {
            revalidationPromise =
              null;

            if (
              revalidationPending &&
              !closed
            ) {
              revalidationPending =
                false;

              scheduleRevalidation();
            }
          },
        );
  }

  async function revalidatePairs() {
    const entries =
      [...pairs.values()]
        .filter(
          (entry) =>
            entry.active &&
            !entry.closed,
        );

    for (
      const entry
      of entries
    ) {
      const [
        clientAuthorization,
        workerAuthorization,
      ] =
        await Promise.all([
          service
            .authorizeDataPlaneAllocation(
              entry.client.claims,
              "client",
            ),
          service
            .authorizeDataPlaneAllocation(
              entry.worker.claims,
              "worker",
            ),
        ]);

      if (
        !sameAllocation(
          clientAuthorization,
          entry,
        ) ||
        !sameAllocation(
          workerAuthorization,
          entry,
        )
      ) {
        closeEntry(
          entry,
          DATA_PLANE_CLOSE_CODES
            .LEASE_INVALIDATED,
          "session lease invalidated",
        );
      }
    }
  }

  function acceptConnection(
    socket,
    grant,
    authorization,
    protocol,
  ) {
    const {
      claims,
    } = authorization;

    const key =
      pairingKey(
        claims,
      );

    let entry =
      pairs.get(key);

    if (!entry) {
      entry = {
        key,
        sessionId:
          claims.sessionId,
        workerId:
          claims.workerId,
        leaseId:
          claims.leaseId,
        client: null,
        worker: null,
        activating: false,
        active: false,
        closed: false,
      };

      pairs.set(
        key,
        entry,
      );
    }

    const role =
      claims.role;

    const existing =
      entry[role];

    if (
      existing &&
      existing.socket.readyState !==
        WebSocket.CLOSED
    ) {
      closeSocket(
        socket,
        DATA_PLANE_CLOSE_CODES
          .DUPLICATE_ROLE,
        "duplicate relay role",
      );

      return;
    }

    const state = {
      socket,
      grant,
      protocol,
      claims,
      role,
      entry,
      peer: null,
      peerTimer: null,
      idleTimer: null,
    };

    entry[role] =
      state;

    installSocketHandlers(
      state,
    );

    state.peerTimer =
      setTimeout(
        () => {
          if (
            entry.closed ||
            entry.active
          ) {
            return;
          }

          closeEntry(
            entry,
            DATA_PLANE_CLOSE_CODES
              .PEER_TIMEOUT,
            "relay peer timeout",
          );
        },
        peerWaitTimeoutMs,
      );

    state.peerTimer.unref();

    void tryPair(
      entry,
    );
  }

  function installSocketHandlers(
    state,
  ) {
    const {
      socket,
    } = state;

    socket.on(
      "message",
      (
        data,
        isBinary,
      ) => {
        if (
          !state.entry.active ||
          !state.peer
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES
              .TRY_AGAIN_LATER,
            "relay peer not ready",
          );

          return;
        }

        /* Do not allow a peer to impersonate the server ready ACK.
         * Legacy v1/v1 opaque traffic is unchanged. */
        if (
          !isBinary &&
          state.peer.protocol === DATA_PLANE_SUBPROTOCOL_V2 &&
          data.toString() === DATA_PLANE_RELAY_READY_V2
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES.PROTOCOL_ERROR,
            "reserved relay control frame",
          );
          return;
        }
        const byteLength =
          Buffer.isBuffer(data)
            ? data.length
            : Buffer.byteLength(
                data,
              );

        if (
          !validateDataPlaneFrameSize(
            byteLength,
          )
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES
              .MESSAGE_TOO_BIG,
            "data-plane frame too large",
          );

          return;
        }

        const peerSocket =
          state.peer.socket;

        if (
          peerSocket.readyState !==
            WebSocket.OPEN
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES
              .TRY_AGAIN_LATER,
            "relay peer unavailable",
          );

          return;
        }

        if (
          isDataPlaneBackpressured(
            peerSocket.bufferedAmount,
          )
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES
              .TRY_AGAIN_LATER,
            "relay backpressure limit exceeded",
          );

          return;
        }

        resetIdleTimers(
          state.entry,
        );

        peerSocket.send(
          data,
          {
            binary:
              isBinary,
            compress:
              false,
          },
          (error) => {
            if (
              error &&
              !state.entry.closed
            ) {
              closeEntry(
                state.entry,
                DATA_PLANE_CLOSE_CODES
                  .INTERNAL_ERROR,
                "relay send failed",
              );
            }
          },
        );
      },
    );

    socket.on(
      "ping",
      () => {
        resetIdleTimer(
          state,
        );
      },
    );

    socket.on(
      "pong",
      () => {
        resetIdleTimer(
          state,
        );
      },
    );

    socket.on(
      "close",
      () => {
        handleSocketClose(
          state,
        );
      },
    );

    socket.on(
      "error",
      () => {
        if (
          !state.entry.closed
        ) {
          closeEntry(
            state.entry,
            DATA_PLANE_CLOSE_CODES
              .INTERNAL_ERROR,
            "relay socket error",
          );
        }
      },
    );
  }

  async function tryPair(
    entry,
  ) {
    if (
      entry.closed ||
      entry.active ||
      entry.activating ||
      !entry.client ||
      !entry.worker
    ) {
      return;
    }

    entry.activating =
      true;

    try {
      /*
       * Revalidate both grants at pairing time.
       * This closes the race between the initial
       * WebSocket upgrade and a lease replacement.
       */
      const [
        clientAuthorization,
        workerAuthorization,
      ] =
        await Promise.all([
          service
            .authorizeDataPlaneGrant(
              entry.client.grant,
              "client",
            ),
          service
            .authorizeDataPlaneGrant(
              entry.worker.grant,
              "worker",
            ),
        ]);

      if (
        !sameAllocation(
          clientAuthorization,
          entry,
        ) ||
        !sameAllocation(
          workerAuthorization,
          entry,
        )
      ) {
        closeEntry(
          entry,
          DATA_PLANE_CLOSE_CODES
            .LEASE_INVALIDATED,
          "session lease invalidated",
        );

        return;
      }

      const session =
        clientAuthorization
          .session;

      if (
        session.status ===
        "connecting"
      ) {
        await service
          .activateSession(
            entry.sessionId,
            {
              workerId:
                entry.workerId,
              leaseId:
                entry.leaseId,
            },
          );
      } else if (
        session.status !==
        "active"
      ) {
        closeEntry(
          entry,
          DATA_PLANE_CLOSE_CODES
            .TRY_AGAIN_LATER,
          "session is not ready for relay activation",
        );

        return;
      }

      if (entry.closed) {
        return;
      }

      entry.active =
        true;

      entry.client.peer =
        entry.worker;

      entry.worker.peer =
        entry.client;

      clearPeerTimer(
        entry.client,
      );

      clearPeerTimer(
        entry.worker,
      );

      resetIdleTimers(
        entry,
      );
      /* Only opt-in v2 peers get the server readiness frame.
       * Link the authorized peer sockets before signaling readiness. */
      for (const state of [entry.client, entry.worker]) {
        if (state.protocol !== DATA_PLANE_SUBPROTOCOL_V2) continue;
        if (state.socket.readyState !== WebSocket.OPEN) {
          closeEntry(entry, DATA_PLANE_CLOSE_CODES.TRY_AGAIN_LATER, "relay peer unavailable");
          break;
        }
        state.socket.send(
          DATA_PLANE_RELAY_READY_V2,
          { binary: false, compress: false },
          (error) => {
            if (error && !entry.closed) {
              closeEntry(entry, DATA_PLANE_CLOSE_CODES.INTERNAL_ERROR, "relay readiness send failed");
            }
          },
        );
      }
    } catch {
      closeEntry(
        entry,
        DATA_PLANE_CLOSE_CODES
          .LEASE_INVALIDATED,
        "session lease invalidated",
      );
    } finally {
      entry.activating =
        false;
    }
  }

  function handleSocketClose(
    state,
  ) {
    clearStateTimers(
      state,
    );

    const {
      entry,
    } = state;

    if (entry.closed) {
      return;
    }

    if (
      entry[state.role] ===
      state
    ) {
      entry[state.role] =
        null;
    }

    const otherRole =
      state.role === "client"
        ? "worker"
        : "client";

    const other =
      entry[otherRole];

    if (other) {
      closeEntry(
        entry,
        DATA_PLANE_CLOSE_CODES
          .TRY_AGAIN_LATER,
        "relay peer disconnected",
      );

      return;
    }

    entry.closed =
      true;

    pairs.delete(
      entry.key,
    );
  }

  function resetIdleTimers(
    entry,
  ) {
    if (entry.client) {
      resetIdleTimer(
        entry.client,
      );
    }

    if (entry.worker) {
      resetIdleTimer(
        entry.worker,
      );
    }
  }

  function resetIdleTimer(
    state,
  ) {
    if (
      state.idleTimer
    ) {
      clearTimeout(
        state.idleTimer,
      );
    }

    state.idleTimer =
      setTimeout(
        () => {
          if (
            !state.entry.closed
          ) {
            closeEntry(
              state.entry,
              DATA_PLANE_CLOSE_CODES
                .PEER_TIMEOUT,
              "relay idle timeout",
            );
          }
        },
        idleTimeoutMs,
      );

    state.idleTimer.unref();
  }

  function closeEntry(
    entry,
    code,
    reason,
  ) {
    if (entry.closed) {
      return;
    }

    entry.closed =
      true;

    pairs.delete(
      entry.key,
    );

    for (
      const state
      of [
        entry.client,
        entry.worker,
      ]
    ) {
      if (!state) {
        continue;
      }

      clearStateTimers(
        state,
      );

      closeSocket(
        state.socket,
        code,
        reason,
      );
    }
  }

  async function stop() {
    if (closed) {
      return;
    }

    closed =
      true;

    server.off(
      "upgrade",
      onUpgrade,
    );

    const unsubscribe =
      unsubscribeEvents;

    unsubscribeEvents =
      null;

    if (unsubscribe) {
      await unsubscribe();
    }

    if (revalidationPromise) {
      await revalidationPromise;
    }

    for (
      const entry
      of [...pairs.values()]
    ) {
      closeEntry(
        entry,
        DATA_PLANE_CLOSE_CODES
          .TRY_AGAIN_LATER,
        "relay shutting down",
      );
    }

    /*
     * Give close frames one event-loop turn to
     * leave before terminating any remaining
     * transport sockets.
     */
    await new Promise(
      (resolve) =>
        setImmediate(
          resolve,
        ),
    );

    for (
      const socket
      of webSocketServer.clients
    ) {
      if (
        socket.readyState !==
          WebSocket.CLOSED
      ) {
        socket.terminate();
      }
    }

    pairs.clear();
  }

  return Object.freeze({
    start,
    stop,

    get connectionCount() {
      return webSocketServer
        .clients.size;
    },

    get pairCount() {
      return pairs.size;
    },
  });
}

async function authorizeGrant(
  service,
  grant,
) {
  const client =
    await service
      .authorizeDataPlaneGrant(
        grant,
        "client",
      );

  if (client) {
    return client;
  }

  return service
    .authorizeDataPlaneGrant(
      grant,
      "worker",
    );
}

function sameAllocation(
  authorization,
  entry,
) {
  return Boolean(
    authorization &&
    authorization.claims
      .sessionId ===
      entry.sessionId &&
    authorization.claims
      .workerId ===
      entry.workerId &&
    authorization.claims
      .leaseId ===
      entry.leaseId,
  );
}

function pairingKey(
  claims,
) {
  return [
    claims.sessionId,
    claims.workerId,
    claims.leaseId,
  ].join("\u0000");
}

function clearPeerTimer(
  state,
) {
  if (
    state?.peerTimer
  ) {
    clearTimeout(
      state.peerTimer,
    );

    state.peerTimer =
      null;
  }
}

function clearStateTimers(
  state,
) {
  clearPeerTimer(
    state,
  );

  if (
    state?.idleTimer
  ) {
    clearTimeout(
      state.idleTimer,
    );

    state.idleTimer =
      null;
  }
}

function closeSocket(
  socket,
  code,
  reason,
) {
  if (
    socket.readyState ===
      WebSocket.CLOSED ||
    socket.readyState ===
      WebSocket.CLOSING
  ) {
    return;
  }

  try {
    socket.close(
      code,
      reason,
    );
  } catch {
    socket.terminate();
  }
}

function rejectUpgrade(
  socket,
  statusCode,
  message,
) {
  if (socket.destroyed) {
    return;
  }

  const statusText =
    statusCode === 400
      ? "Bad Request"
      : statusCode === 401
        ? "Unauthorized"
        : statusCode === 404
          ? "Not Found"
          : "Service Unavailable";

  const body =
    `${message}\n`;

  try {
    socket.write(
      [
        `HTTP/1.1 ${statusCode} ${statusText}`,
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ].join("\r\n"),
    );
  } finally {
    socket.destroy();
  }
}

function positiveSafeInteger(
  value,
  name,
) {
  if (
    !Number.isSafeInteger(
      value,
    ) ||
    value <= 0
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer`,
    );
  }
}
