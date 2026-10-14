import assert from "node:assert/strict";
import test from "node:test";

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
  DATA_PLANE_SUBPROTOCOL,
} from "../src/shared/data-plane-contract.mjs";

const tokens = {
  client:
    "relay-client-token-that-is-at-least-32-characters",
  worker:
    "relay-worker-token-that-is-at-least-32-characters",
  admin:
    "relay-admin-token-that-is-at-least-32-characters",
};

const signingKey =
  "relay-data-plane-signing-key-that-is-at-least-32-characters";

function config() {
  return {
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
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
      "relay-test-worker",
    version: "test",
    labels: {},
    capabilities: [
      "speech.streaming",
    ],
    warmModels: [],
    modelInventory: [],
    gpus: [
      {
        uuid:
          "GPU-RELAY-TEST",
        index: 0,
        name:
          "Relay Test GPU",
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
      "relay-test",
    capability:
      "speech.streaming",
    requirements: {
      minVramMiB:
        1_000,
      capabilities: [
        "speech.streaming",
      ],
    },
    recovery: {
      maxInterruptions: 1,
    },
  };
}

async function setupSession(
  app,
) {
  const worker =
    await app.service
      .registerWorker(
        workerRequest(),
      );

  const allocated =
    (
      await app.service
        .submitSession(
          sessionRequest(),
        )
    ).session;

  assert.equal(
    allocated.status,
    "allocated",
  );

  const connecting =
    await app.service
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
    await app.service
      .issueDataPlaneGrant(
        connecting.id,
        "client",
      );

  const workerGrant =
    await app.service
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

  return {
    worker,
    connecting,
    clientGrant,
    workerGrant,
  };
}

function connect(
  address,
  token,
) {
  return new WebSocket(
    `ws://127.0.0.1:${address.port}${DATA_PLANE_PATH}`,
    createDataPlaneProtocols(
      token,
    ),
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

function nextMessage(
  socket,
) {
  return new Promise(
    (
      resolve,
      reject,
    ) => {
      socket.once(
        "message",
        (
          data,
          isBinary,
        ) => {
          resolve({
            data,
            isBinary,
          });
        },
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
  timeoutMs = 2_000,
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
    `Timed out waiting for ${sessionId} to become ${status}; current state is ${session?.status}`,
  );
}

test(
  "relay pairs current client and worker grants, activates the session, and forwards opaque frames",
  async () => {
    const app =
      createControlPlane(
        config(),
      );

    const address =
      await app.start();

    let client;
    let workerSocket;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      await waitForOpen(
        client,
      );

      assert.equal(
        client.protocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      /*
       * One authenticated side is not enough
       * to claim an active data plane.
       */
      assert.equal(
        (
          await app.database
            .getSession(
              connecting.id,
            )
        ).status,
        "connecting",
      );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await waitForOpen(
        workerSocket,
      );

      assert.equal(
        workerSocket.protocol,
        DATA_PLANE_SUBPROTOCOL,
      );

      const active =
        await waitForSession(
          app.database,
          connecting.id,
          "active",
        );

      assert.equal(
        active.leaseId,
        connecting.leaseId,
      );

      const binaryReceived =
        nextMessage(
          workerSocket,
        );

      const binaryPayload =
        Buffer.from([
          0x00,
          0x7f,
          0x80,
          0xff,
        ]);

      client.send(
        binaryPayload,
        {
          binary: true,
        },
      );

      const binary =
        await binaryReceived;

      assert.equal(
        binary.isBinary,
        true,
      );

      assert.deepEqual(
        binary.data,
        binaryPayload,
      );

      const textReceived =
        nextMessage(
          client,
        );

      workerSocket.send(
        JSON.stringify({
          type:
            "adapter-owned-payload",
          value: 42,
        }),
      );

      const text =
        await textReceived;

      assert.equal(
        text.isBinary,
        false,
      );

      assert.equal(
        text.data.toString(),
        JSON.stringify({
          type:
            "adapter-owned-payload",
          value: 42,
        }),
      );

      /*
       * Relay traffic is not durable state.
       */
      const stored =
        await app.database
          .getSession(
            connecting.id,
          );

      assert.equal(
        JSON.stringify(
          stored,
        ).includes(
          "adapter-owned-payload",
        ),
        false,
      );

      const events =
        await app.database
          .listEventsAfter(0);

      assert.equal(
        JSON.stringify(
          events,
        ).includes(
          "adapter-owned-payload",
        ),
        false,
      );
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      await app.stop();
    }
  },
);

test(
  "relay rejects a duplicate role for the same current allocation",
  async () => {
    const app =
      createControlPlane(
        config(),
        {
          dataPlaneRelayOptions: {
            peerWaitTimeoutMs:
              2_000,
          },
        },
      );

    const address =
      await app.start();

    let first;
    let duplicate;

    try {
      const {
        clientGrant,
      } =
        await setupSession(
          app,
        );

      first =
        connect(
          address,
          clientGrant.token,
        );

      await waitForOpen(
        first,
      );

      duplicate =
        connect(
          address,
          clientGrant.token,
        );

      const closed =
        nextClose(
          duplicate,
        );

      await waitForOpen(
        duplicate,
      );

      assert.deepEqual(
        await closed,
        {
          code:
            DATA_PLANE_CLOSE_CODES
              .DUPLICATE_ROLE,
          reason:
            "duplicate relay role",
        },
      );
    } finally {
      first?.terminate();
      duplicate?.terminate();

      await app.stop();
    }
  },
);

test(
  "relay closes an unmatched authenticated side after the bounded peer wait",
  async () => {
    const app =
      createControlPlane(
        config(),
        {
          dataPlaneRelayOptions: {
            peerWaitTimeoutMs:
              50,
            idleTimeoutMs:
              2_000,
          },
        },
      );

    const address =
      await app.start();

    let client;

    try {
      const {
        connecting,
        clientGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      const closed =
        nextClose(
          client,
        );

      await waitForOpen(
        client,
      );

      assert.deepEqual(
        await closed,
        {
          code:
            DATA_PLANE_CLOSE_CODES
              .PEER_TIMEOUT,
          reason:
            "relay peer timeout",
        },
      );

      assert.equal(
        (
          await app.database
            .getSession(
              connecting.id,
            )
        ).status,
        "connecting",
      );
    } finally {
      client?.terminate();

      await app.stop();
    }
  },
);

test(
  "a committed session close invalidates an already-active relay pair",
  async () => {
    const app =
      createControlPlane(
        config(),
      );

    const address =
      await app.start();

    let client;
    let workerSocket;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          client,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        app.database,
        connecting.id,
        "active",
      );

      const clientClosed =
        nextClose(
          client,
        );

      const workerClosed =
        nextClose(
          workerSocket,
        );

      await app.service
        .closeSession(
          connecting.id,
        );

      const [
        clientResult,
        workerResult,
      ] =
        await Promise.all([
          clientClosed,
          workerClosed,
        ]);

      assert.equal(
        clientResult.code,
        DATA_PLANE_CLOSE_CODES
          .LEASE_INVALIDATED,
      );

      assert.equal(
        workerResult.code,
        DATA_PLANE_CLOSE_CODES
          .LEASE_INVALIDATED,
      );

      assert.equal(
        clientResult.reason,
        "session lease invalidated",
      );

      assert.equal(
        workerResult.reason,
        "session lease invalidated",
      );
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      await app.stop();
    }
  },
);

test(
  "active relay pair closes after the bounded idle timeout",
  async () => {
    const app =
      createControlPlane(
        config(),
        {
          dataPlaneRelayOptions: {
            peerWaitTimeoutMs:
              1_000,
            idleTimeoutMs:
              60,
          },
        },
      );

    const address =
      await app.start();

    let client;
    let workerSocket;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          client,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        app.database,
        connecting.id,
        "active",
      );

      const [
        clientResult,
        workerResult,
      ] =
        await Promise.all([
          nextClose(
            client,
          ),
          nextClose(
            workerSocket,
          ),
        ]);

      assert.equal(
        clientResult.code,
        DATA_PLANE_CLOSE_CODES
          .PEER_TIMEOUT,
      );

      assert.equal(
        workerResult.code,
        DATA_PLANE_CLOSE_CODES
          .PEER_TIMEOUT,
      );

      assert.equal(
        clientResult.reason,
        "relay idle timeout",
      );

      assert.equal(
        workerResult.reason,
        "relay idle timeout",
      );
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      await app.stop();
    }
  },
);

test(
  "relay enforces the one MiB maximum payload on a live pair",
  async () => {
    const app =
      createControlPlane(
        config(),
      );

    const address =
      await app.start();

    let client;
    let workerSocket;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          client,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        app.database,
        connecting.id,
        "active",
      );

      const clientClosed =
        nextClose(
          client,
        );

      client.send(
        Buffer.alloc(
          1_048_577,
        ),
        {
          binary: true,
        },
      );

      const result =
        await clientClosed;

      assert.equal(
        result.code,
        DATA_PLANE_CLOSE_CODES
          .MESSAGE_TOO_BIG,
      );
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      await app.stop();
    }
  },
);

test(
  "control-plane shutdown tears down active relay transports",
  async () => {
    const app =
      createControlPlane(
        config(),
      );

    const address =
      await app.start();

    let client;
    let workerSocket;
    let stopped =
      false;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          client,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        app.database,
        connecting.id,
        "active",
      );

      const clientClosed =
        nextClose(
          client,
        );

      const workerClosed =
        nextClose(
          workerSocket,
        );

      await app.stop();
      stopped = true;

      const [
        clientResult,
        workerResult,
      ] =
        await Promise.all([
          clientClosed,
          workerClosed,
        ]);

      for (
        const result
        of [
          clientResult,
          workerResult,
        ]
      ) {
        assert.ok(
          result.code ===
            DATA_PLANE_CLOSE_CODES
              .TRY_AGAIN_LATER ||
          result.code ===
            1006,
        );
      }
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      if (!stopped) {
        await app.stop();
      }
    }
  },
);

test(
  "an expired admission grant does not terminate an established relay while its allocation remains current",
  async () => {
    let now =
      1_700_800_000_000;

    const app =
      createControlPlane(
        {
          ...config(),
          dataPlaneGrantTtlMs:
            100,
          leaseDurationMs:
            30_000,
        },
        {
          clock:
            () => now,
        },
      );

    const address =
      await app.start();

    let client;
    let workerSocket;

    try {
      const {
        connecting,
        clientGrant,
        workerGrant,
      } =
        await setupSession(
          app,
        );

      client =
        connect(
          address,
          clientGrant.token,
        );

      workerSocket =
        connect(
          address,
          workerGrant.token,
        );

      await Promise.all([
        waitForOpen(
          client,
        ),
        waitForOpen(
          workerSocket,
        ),
      ]);

      await waitForSession(
        app.database,
        connecting.id,
        "active",
      );

      const originalAuthorization =
        await app.service
          .authorizeDataPlaneGrant(
            clientGrant.token,
            "client",
          );

      assert.ok(
        originalAuthorization,
      );

      /*
       * Expire only the short-lived admission
       * credential. The durable lease is still
       * current.
       */
      now += 101;

      assert.equal(
        await app.service
          .authorizeDataPlaneGrant(
            clientGrant.token,
            "client",
          ),
        null,
      );

      assert.ok(
        await app.service
          .authorizeDataPlaneAllocation(
            originalAuthorization
              .claims,
            "client",
          ),
      );

      /*
       * Wake live relay revalidation with an
       * unrelated committed lifecycle event.
       * A healthy established session must remain
       * connected even though its admission grant
       * has expired.
       */
      const unrelated =
        workerRequest();

      unrelated.name =
        "relay-unrelated-worker";

      unrelated.gpus =
        unrelated.gpus.map(
          (gpu) => ({
            ...gpu,
            uuid:
              "GPU-RELAY-UNRELATED",
          }),
        );

      await app.service
        .registerWorker(
          unrelated,
        );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            30,
          ),
      );

      assert.equal(
        client.readyState,
        WebSocket.OPEN,
      );

      assert.equal(
        workerSocket.readyState,
        WebSocket.OPEN,
      );

      const received =
        nextMessage(
          workerSocket,
        );

      const payload =
        Buffer.from([
          0x10,
          0x20,
          0x30,
          0x40,
        ]);

      client.send(
        payload,
        {
          binary: true,
        },
      );

      const relayed =
        await received;

      assert.equal(
        relayed.isBinary,
        true,
      );

      assert.deepEqual(
        relayed.data,
        payload,
      );

      assert.equal(
        (
          await app.database
            .getSession(
              connecting.id,
            )
        ).status,
        "active",
      );
    } finally {
      client?.terminate();
      workerSocket?.terminate();

      await app.stop();
    }
  },
);
