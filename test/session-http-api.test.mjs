import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

const tokens = {
  client:
    "session-http-client-token-at-least-32-characters",
  worker:
    "session-http-worker-token-at-least-32-characters",
  admin:
    "session-http-admin-token-at-least-32-characters",
};

function config() {
  return {
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    heartbeatTimeoutMs:
      60_000,
    leaseDurationMs:
      10_000,
    schedulerIntervalMs:
      60_000,
    vramSafetyMiB: 512,
  };
}

async function request(
  baseUrl,
  method,
  path,
  body = undefined,
  token = tokens.client,
  extraHeaders = {},
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
          ...extraHeaders,
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      },
    );

  return {
    response,
    body:
      await response.json(),
  };
}

async function registerSessionWorker(
  baseUrl,
) {
  const result =
    await request(
      baseUrl,
      "POST",
      "/v1/workers/register",
      {
        name:
          "session-http-worker",
        version: "test",
        labels: {},
        capabilities: [
          "speech.streaming",
        ],
        warmModels: [],
        gpus: [
          {
            uuid:
              "GPU-SESSION-HTTP",
            index: 0,
            name:
              "Session HTTP GPU",
            memoryTotalMiB:
              24_576,
            memoryUsedMiB: 0,
            utilizationPercent: 0,
            temperatureC: 40,
            powerDrawWatts: 40,
          },
        ],
      },
      tokens.worker,
    );

  assert.equal(
    result.response.status,
    200,
  );

  return result.body.worker;
}

function sessionRequest() {
  return {
    projectId:
      "session-http-test",
    capability:
      "speech.streaming",
    requirements: {
      minVramMiB: 1_000,
      capabilities: [
        "speech.streaming",
      ],
    },
    metadata: {
      protocol:
        "transgo-v1",
    },
    recovery: {
      maxInterruptions: 1,
    },
  };
}

test(
  "authenticated HTTP session API supports allocation lifecycle and lease discovery",
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
      const worker =
        await registerSessionWorker(
          baseUrl,
        );

      const submitted =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions",
          sessionRequest(),
          tokens.client,
          {
            "Idempotency-Key":
              "session-http-request-1",
          },
        );

      assert.equal(
        submitted.response.status,
        201,
      );

      assert.equal(
        submitted.body
          .session.status,
        "allocated",
      );

      const session =
        submitted.body.session;

      assert.equal(
        session.assignedWorkerId,
        worker.id,
      );

      const duplicate =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions",
          {
            ...sessionRequest(),
            priority: 999,
          },
          tokens.client,
          {
            "Idempotency-Key":
              "session-http-request-1",
          },
        );

      assert.equal(
        duplicate.response.status,
        200,
      );

      assert.equal(
        duplicate.body.duplicate,
        true,
      );

      assert.equal(
        duplicate.body.session.id,
        session.id,
      );

      const listed =
        await request(
          baseUrl,
          "GET",
          "/v1/sessions?status=allocated&limit=10",
          undefined,
          tokens.client,
        );

      assert.equal(
        listed.response.status,
        200,
      );

      assert.equal(
        listed.body.sessions.length,
        1,
      );

      const fetched =
        await request(
          baseUrl,
          "GET",
          `/v1/sessions/${session.id}`,
          undefined,
          tokens.client,
        );

      assert.equal(
        fetched.response.status,
        200,
      );

      assert.equal(
        fetched.body.session.id,
        session.id,
      );

      const leases =
        await request(
          baseUrl,
          "GET",
          `/v1/workers/${worker.id}/leases`,
          undefined,
          tokens.worker,
        );

      assert.equal(
        leases.response.status,
        200,
      );

      assert.ok(
        Array.isArray(
          leases.body.jobs,
        ),
      );

      assert.equal(
        leases.body.sessions.length,
        1,
      );

      assert.equal(
        leases.body.sessions[0].id,
        session.id,
      );

      const started =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/start`,
          {
            workerId: worker.id,
            leaseId:
              session.leaseId,
          },
          tokens.worker,
        );

      assert.equal(
        started.response.status,
        200,
      );

      assert.equal(
        started.body.session.status,
        "connecting",
      );

      const activated =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/activate`,
          {
            workerId: worker.id,
            leaseId:
              session.leaseId,
          },
          tokens.worker,
        );

      assert.equal(
        activated.response.status,
        200,
      );

      assert.equal(
        activated.body.session.status,
        "active",
      );

      const renewed =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/renew`,
          {
            workerId: worker.id,
            leaseId:
              session.leaseId,
          },
          tokens.worker,
        );

      assert.equal(
        renewed.response.status,
        200,
      );

      assert.equal(
        renewed.body.session.status,
        "active",
      );

      const closed =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${session.id}/close`,
          {},
          tokens.client,
        );

      assert.equal(
        closed.response.status,
        200,
      );

      assert.equal(
        closed.body.session.status,
        "closed",
      );

      const leasesAfterClose =
        await request(
          baseUrl,
          "GET",
          `/v1/workers/${worker.id}/leases`,
          undefined,
          tokens.worker,
        );

      assert.equal(
        leasesAfterClose.body
          .sessions.length,
        0,
      );
    } finally {
      await app.stop();
    }
  },
);

test(
  "HTTP session routes enforce client and worker scopes",
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
      const workerCreate =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions",
          sessionRequest(),
          tokens.worker,
        );

      assert.equal(
        workerCreate.response.status,
        401,
      );

      const workerList =
        await request(
          baseUrl,
          "GET",
          "/v1/sessions",
          undefined,
          tokens.worker,
        );

      assert.equal(
        workerList.response.status,
        401,
      );

      for (
        const action
        of [
          "start",
          "activate",
          "renew",
        ]
      ) {
        const result =
          await request(
            baseUrl,
            "POST",
            `/v1/sessions/session-example/${action}`,
            {
              workerId:
                "worker-example",
              leaseId:
                "lease-example",
            },
            tokens.client,
          );

        assert.equal(
          result.response.status,
          401,
        );
      }

      const workerClose =
        await request(
          baseUrl,
          "POST",
          "/v1/sessions/session-example/close",
          {},
          tokens.worker,
        );

      assert.equal(
        workerClose.response.status,
        401,
      );

      const missing =
        await request(
          baseUrl,
          "GET",
          "/v1/sessions/session-missing",
          undefined,
          tokens.client,
        );

      assert.equal(
        missing.response.status,
        404,
      );

      assert.equal(
        missing.body.error.code,
        "not_found",
      );
    } finally {
      await app.stop();
    }
  },
);

test(
  "client may close an unallocated requested session over HTTP",
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

      assert.equal(
        submitted.body
          .session.status,
        "requested",
      );

      const sessionId =
        submitted.body.session.id;

      const closed =
        await request(
          baseUrl,
          "POST",
          `/v1/sessions/${sessionId}/close`,
          {},
          tokens.client,
        );

      assert.equal(
        closed.response.status,
        200,
      );

      assert.equal(
        closed.body.session.status,
        "closed",
      );
    } finally {
      await app.stop();
    }
  },
);
