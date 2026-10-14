import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";
import {
  verifyDataPlaneGrant,
} from "../src/shared/data-plane-grant.mjs";

const tokens = {
  client:
    "grant-http-client-token-at-least-32-characters",
  worker:
    "grant-http-worker-token-at-least-32-characters",
  admin:
    "grant-http-admin-token-at-least-32-characters",
};

const signingKey =
  "grant-http-signing-key-that-is-at-least-32-characters";

function config(
  overrides = {},
) {
  return {
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    dataPlaneSigningKey:
      signingKey,
    dataPlaneGrantTtlMs:
      5_000,
    heartbeatTimeoutMs:
      60_000,
    leaseDurationMs:
      10_000,
    schedulerIntervalMs:
      60_000,
    vramSafetyMiB: 512,
    ...overrides,
  };
}

function workerRequest(
  name,
  gpuUuid,
) {
  return {
    name,
    version: "test",
    labels: {},
    capabilities: [
      "speech.streaming",
    ],
    warmModels: [],
    modelInventory: [],
    gpus: [
      {
        uuid: gpuUuid,
        index: 0,
        name:
          `${name} GPU`,
        memoryTotalMiB:
          24_576,
        memoryUsedMiB: 0,
        utilizationPercent: 0,
        temperatureC: 40,
        powerDrawWatts: 75,
      },
    ],
  };
}

function sessionRequest() {
  return {
    projectId:
      "data-plane-grant-test",
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

async function request(
  baseUrl,
  method,
  path,
  body,
  token,
) {
  const response =
    await fetch(
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization:
            `Bearer ${token}`,
          ...(
            body === undefined
              ? {}
              : {
                  "Content-Type":
                    "application/json",
                }
          ),
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                body,
              ),
      },
    );

  return {
    response,
    body:
      await response
        .json()
        .catch(
          () => ({}),
        ),
  };
}

test(
  "HTTP issues client and worker grants bound to the current session lease",
  async () => {
    let now =
      1_700_500_000_000;

    const app =
      createControlPlane(
        config(),
        {
          clock:
            () => now,
        },
      );

    const address =
      await app.start();

    const baseUrl =
      `http://127.0.0.1:${address.port}`;

    try {
      const registered =
        await request(
          baseUrl,
          "POST",
          "/v1/workers/register",
          workerRequest(
            "grant-http-worker",
            "GPU-GRANT-HTTP",
          ),
          tokens.worker,
        );

      assert.equal(
        registered.response.status,
        200,
      );

      const worker =
        registered.body.worker;

      const submitted =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions",
          sessionRequest(),
          tokens.client,
        );

      assert.equal(
        submitted.response.status,
        201,
      );

      const session =
        submitted.body.session;

      assert.equal(
        session.status,
        "allocated",
      );

      const clientGrant =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/data-plane/client-grant`,
          undefined,
          tokens.client,
        );

      assert.equal(
        clientGrant.response.status,
        200,
      );

      const clientClaims =
        verifyDataPlaneGrant(
          clientGrant.body
            .grant.token,
          signingKey,
          {
            now,
          },
        );

      assert.equal(
        clientClaims.role,
        "client",
      );

      assert.equal(
        clientClaims.sessionId,
        session.id,
      );

      assert.equal(
        clientClaims.workerId,
        worker.id,
      );

      assert.equal(
        clientClaims.leaseId,
        session.leaseId,
      );

      assert.equal(
        clientClaims.expiresAt,
        now + 5_000,
      );

      assert.equal(
        clientGrant.body
          .grant.expiresAt,
        clientClaims.expiresAt,
      );

      const wrongWorkerGrant =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/data-plane/worker-grant`,
          {
            workerId:
              worker.id,
            leaseId:
              "lease_wrong",
          },
          tokens.worker,
        );

      assert.equal(
        wrongWorkerGrant
          .response.status,
        409,
      );

      const workerGrant =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/data-plane/worker-grant`,
          {
            workerId:
              worker.id,
            leaseId:
              session.leaseId,
          },
          tokens.worker,
        );

      assert.equal(
        workerGrant.response.status,
        200,
      );

      const workerClaims =
        verifyDataPlaneGrant(
          workerGrant.body
            .grant.token,
          signingKey,
          {
            now,
          },
        );

      assert.equal(
        workerClaims.role,
        "worker",
      );

      assert.equal(
        workerClaims.sessionId,
        session.id,
      );

      assert.equal(
        workerClaims.workerId,
        worker.id,
      );

      assert.equal(
        workerClaims.leaseId,
        session.leaseId,
      );

      assert.ok(
        await app.service
          .authorizeDataPlaneGrant(
            clientGrant.body
              .grant.token,
            "client",
          ),
      );

      assert.ok(
        await app.service
          .authorizeDataPlaneGrant(
            workerGrant.body
              .grant.token,
            "worker",
          ),
      );

      assert.equal(
        await app.service
          .authorizeDataPlaneGrant(
            clientGrant.body
              .grant.token,
            "worker",
          ),
        null,
      );

      const stored =
        await app.database
          .getSession(
            session.id,
          );

      assert.equal(
        JSON.stringify(
          stored,
        ).includes(
          clientGrant.body
            .grant.token,
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
          clientGrant.body
            .grant.token,
        ),
        false,
      );

      now += 5_000;

      assert.equal(
        await app.service
          .authorizeDataPlaneGrant(
            clientGrant.body
              .grant.token,
            "client",
          ),
        null,
      );
    } finally {
      await app.stop();
    }
  },
);

test(
  "grant HTTP routes preserve client and worker scope boundaries",
  async () => {
    const app =
      createControlPlane(
        config(),
      );

    const address =
      await app.start();

    const baseUrl =
      `http://127.0.0.1:${address.port}`;

    try {
      const registered =
        await request(
          baseUrl,
          "POST",
          "/v1/workers/register",
          workerRequest(
            "grant-scope-worker",
            "GPU-GRANT-SCOPE",
          ),
          tokens.worker,
        );

      const submitted =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions",
          sessionRequest(),
          tokens.client,
        );

      const session =
        submitted.body.session;

      const worker =
        registered.body.worker;

      const workerCannotGetClient =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/data-plane/client-grant`,
          undefined,
          tokens.worker,
        );

      assert.equal(
        workerCannotGetClient
          .response.status,
        401,
      );

      const clientCannotGetWorker =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/data-plane/worker-grant`,
          {
            workerId:
              worker.id,
            leaseId:
              session.leaseId,
          },
          tokens.client,
        );

      assert.equal(
        clientCannotGetWorker
          .response.status,
        401,
      );
    } finally {
      await app.stop();
    }
  },
);

test(
  "authoritative lease replacement invalidates an unexpired old grant",
  async () => {
    let now =
      1_700_600_000_000;

    const app =
      createControlPlane(
        config({
          heartbeatTimeoutMs:
            1_000,
          leaseDurationMs:
            30_000,
          dataPlaneGrantTtlMs:
            15_000,
        }),
        {
          clock:
            () => now,
        },
      );

    await app.start();

    try {
      const originalWorker =
        await app.service
          .registerWorker(
            workerRequest(
              "grant-original-worker",
              "GPU-GRANT-ORIGINAL",
            ),
          );

      const initial =
        (
          await app.service
            .submitSession(
              sessionRequest(),
            )
        ).session;

      assert.equal(
        initial.status,
        "allocated",
      );

      assert.equal(
        initial.assignedWorkerId,
        originalWorker.id,
      );

      const oldGrant =
        await app.service
          .issueDataPlaneGrant(
            initial.id,
            "client",
          );

      assert.ok(
        await app.service
          .authorizeDataPlaneGrant(
            oldGrant.token,
            "client",
          ),
      );

      now += 1_001;

      assert.ok(
        oldGrant.expiresAt >
        now,
      );

      const replacementWorker =
        await app.service
          .registerWorker(
            workerRequest(
              "grant-replacement-worker",
              "GPU-GRANT-REPLACEMENT",
            ),
          );

      const replaced =
        await app.database
          .getSession(
            initial.id,
          );

      assert.equal(
        replaced.status,
        "allocated",
      );

      assert.equal(
        replaced.interruptionCount,
        1,
      );

      assert.equal(
        replaced.assignedWorkerId,
        replacementWorker.id,
      );

      assert.notEqual(
        replaced.leaseId,
        initial.leaseId,
      );

      /*
       * The old grant is still cryptographically
       * inside its expiry window here. It must fail
       * specifically because authoritative
       * session/lease state changed.
       */
      assert.ok(
        verifyDataPlaneGrant(
          oldGrant.token,
          signingKey,
          {
            now,
          },
        ),
      );

      assert.equal(
        await app.service
          .authorizeDataPlaneGrant(
            oldGrant.token,
            "client",
          ),
        null,
      );

      const replacementGrant =
        await app.service
          .issueDataPlaneGrant(
            replaced.id,
            "client",
          );

      const authorized =
        await app.service
          .authorizeDataPlaneGrant(
            replacementGrant.token,
            "client",
          );

      assert.equal(
        authorized.session
          .assignedWorkerId,
        replacementWorker.id,
      );

      assert.equal(
        authorized.claims
          .leaseId,
        replaced.leaseId,
      );
    } finally {
      await app.stop();
    }
  },
);
