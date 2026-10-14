import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";
import {
  WebSocket,
} from "ws";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  createDataPlaneProtocols,
  DATA_PLANE_CLOSE_CODES,
  DATA_PLANE_PATH,
} from "../src/shared/data-plane-contract.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env
    .GPULINK_TEST_POSTGRES_URL;

const tokens = {
  client:
    "postgres-relay-client-token-at-least-32-characters",
  worker:
    "postgres-relay-worker-token-at-least-32-characters",
  admin:
    "postgres-relay-admin-token-at-least-32-characters",
};

const signingKey =
  "postgres-relay-signing-key-that-is-at-least-32-characters";

function config() {
  return {
    host:
      "127.0.0.1",
    port: 0,
    database:
      "postgres",
    databaseUrl:
      connectionString,
    dataPath:
      ":memory:",
    tokens,
    dataPlaneSigningKey:
      signingKey,
    dataPlaneGrantTtlMs:
      15_000,
    heartbeatTimeoutMs:
      60_000,
    leaseDurationMs:
      30_000,
    schedulerIntervalMs:
      60_000,
    vramSafetyMiB:
      512,
  };
}

function workerRequest() {
  return {
    name:
      "postgres-relay-worker",
    version:
      "test",
    labels: {},
    capabilities: [
      "diagnostic.echo",
    ],
    warmModels: [],
    modelInventory: [],
    gpus: [
      {
        uuid:
          "GPU-POSTGRES-RELAY",
        index: 0,
        name:
          "PostgreSQL Relay Test GPU",
        memoryTotalMiB:
          24_576,
        memoryUsedMiB: 0,
        utilizationPercent: 0,
        temperatureC: 35,
        powerDrawWatts: 25,
      },
    ],
  };
}

function sessionRequest() {
  return {
    projectId:
      "postgres-cross-replica-relay",
    capability:
      "diagnostic.echo",
    requirements: {
      minVramMiB:
        1_000,
      capabilities: [
        "diagnostic.echo",
      ],
    },
    recovery: {
      maxInterruptions: 1,
    },
  };
}

function connect(
  address,
  grant,
) {
  return new WebSocket(
    `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
    createDataPlaneProtocols(
      grant,
    ),
    {
      perMessageDeflate:
        false,
    },
  );
}

function waitForOpen(
  socket,
) {
  if (
    socket.readyState ===
    WebSocket.OPEN
  ) {
    return Promise.resolve();
  }

  return new Promise(
    (
      resolve,
      reject,
    ) => {
      socket.once(
        "open",
        resolve,
      );

      socket.once(
        "error",
        reject,
      );
    },
  );
}

function nextClose(
  socket,
) {
  return new Promise(
    (resolve) => {
      socket.once(
        "close",
        (
          code,
          reason,
        ) => {
          resolve({
            code,
            reason:
              reason.toString(),
          });
        },
      );
    },
  );
}

async function waitForSession(
  database,
  sessionId,
  status,
  timeoutMs = 3_000,
) {
  const deadline =
    Date.now() +
    timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    const session =
      await database
        .getSession(
          sessionId,
        );

    if (
      session?.status ===
      status
    ) {
      return session;
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          10,
        ),
    );
  }

  const session =
    await database
      .getSession(
        sessionId,
      );

  throw new Error(
    `Timed out waiting for ${sessionId} to become ${status}; current=${session?.status}`,
  );
}

async function cleanDatabase() {
  const pool =
    new Pool({
      connectionString,
      max: 1,
    });

  try {
    await pool.query(`
      TRUNCATE TABLE
        events,
        sessions,
        jobs,
        workers
      RESTART IDENTITY
      CASCADE
    `);
  } finally {
    await pool.end();
  }
}

test(
  "PostgreSQL notification invalidates an active relay on another control-plane replica",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    let replicaA;
    let replicaB;

    let clientSocket;
    let workerSocket;

    try {
      /*
       * Both processes use the same PostgreSQL
       * authority but maintain independent relay
       * and subscription state.
       */
      replicaA =
        createControlPlane(
          config(),
        );

      replicaB =
        createControlPlane(
          config(),
        );

      const addressA =
        await replicaA.start();

      await replicaB.start();

      const worker =
        await replicaA.service
          .registerWorker(
            workerRequest(),
          );

      const allocated =
        (
          await replicaA.service
            .submitSession(
              sessionRequest(),
            )
        ).session;

      assert.equal(
        allocated.status,
        "allocated",
      );

      const connecting =
        await replicaA.service
          .startSession(
            allocated.id,
            {
              workerId:
                worker.id,
              leaseId:
                allocated.leaseId,
            },
          );

      assert.equal(
        connecting.status,
        "connecting",
      );

      const clientGrant =
        await replicaA.service
          .issueDataPlaneGrant(
            connecting.id,
            "client",
          );

      const workerGrant =
        await replicaA.service
          .issueDataPlaneGrant(
            connecting.id,
            "worker",
            {
              workerId:
                worker.id,
              leaseId:
                connecting.leaseId,
            },
          );

      clientSocket =
        connect(
          addressA,
          clientGrant.token,
        );

      workerSocket =
        connect(
          addressA,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          clientSocket,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        replicaA.database,
        connecting.id,
        "active",
      );

      const clientClosed =
        nextClose(
          clientSocket,
        );

      const workerClosed =
        nextClose(
          workerSocket,
        );

      /*
       * The durable state mutation occurs through
       * replica B. Replica A's relay must learn
       * about it through PostgreSQL event
       * notification and revalidate its own pair.
       */
      const closed =
        await replicaB.service
          .closeSession(
            connecting.id,
          );

      assert.equal(
        closed.status,
        "closed",
      );

      const [
        clientResult,
        workerResult,
      ] =
        await Promise.all([
          clientClosed,
          workerClosed,
        ]);

      assert.deepEqual(
        clientResult,
        {
          code:
            DATA_PLANE_CLOSE_CODES
              .LEASE_INVALIDATED,
          reason:
            "session lease invalidated",
        },
      );

      assert.deepEqual(
        workerResult,
        {
          code:
            DATA_PLANE_CLOSE_CODES
              .LEASE_INVALIDATED,
          reason:
            "session lease invalidated",
        },
      );

      assert.equal(
        (
          await replicaA.database
            .getSession(
              connecting.id,
            )
        ).status,
        "closed",
      );
    } finally {
      clientSocket?.terminate();
      workerSocket?.terminate();

      if (replicaB) {
        await replicaB.stop();
      }

      if (replicaA) {
        await replicaA.stop();
      }

      if (connectionString) {
        await cleanDatabase();
      }
    }
  },
);
