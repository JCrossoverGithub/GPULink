import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlane,
} from "../src/control-plane/app.mjs";

import {
  PostgresPersistence,
} from "../src/control-plane/persistence/postgres.mjs";

const tokens = {
  client:
    "sse-client-token-at-least-32-characters",
  worker:
    "sse-worker-token-at-least-32-characters",
  admin:
    "sse-admin-token-at-least-32-characters",
};

function config(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    dataPath: ":memory:",
    tokens,
    heartbeatTimeoutMs: 1_000,
    leaseDurationMs: 10_000,
    schedulerIntervalMs: 60_000,
    vramSafetyMiB: 512,
    ...overrides,
  };
}

async function readSseUntil(
  response,
  predicate,
  timeoutMs = 2_000,
) {
  assert.ok(
    response.body,
    "SSE response must have a body",
  );

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  try {
    for (;;) {
      const {
        value,
        done,
      } = await readWithTimeout(
        reader,
        timeoutMs,
      );

      if (done) {
        throw new Error(
          "SSE stream ended before expected event",
        );
      }

      buffer +=
        decoder.decode(
          value,
          {
            stream: true,
          },
        );

      for (;;) {
        const boundary =
          buffer.indexOf("\n\n");

        if (boundary === -1) {
          break;
        }

        const frame =
          buffer.slice(
            0,
            boundary,
          );

        buffer =
          buffer.slice(
            boundary + 2,
          );

        const dataLine =
          frame
            .split("\n")
            .find(
              (line) =>
                line.startsWith(
                  "data: ",
                ),
            );

        if (!dataLine) {
          continue;
        }

        const event =
          JSON.parse(
            dataLine.slice(
              "data: ".length,
            ),
          );

        if (predicate(event)) {
          return event;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream may already be closed.
    }
  }
}

async function readWithTimeout(
  reader,
  timeoutMs,
) {
  let timer;

  try {
    return await Promise.race([
      reader.read(),

      new Promise(
        (_, reject) => {
          timer =
            setTimeout(
              () => {
                reject(
                  new Error(
                    "timed out waiting for SSE event",
                  ),
                );
              },
              timeoutMs,
            );
        },
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "scheduler-generated events wake an HTTP SSE client",
  async () => {
    let now =
      1_700_000_000_000;

    const app =
      createControlPlane(
        config(),
        {
          clock: () => now,
        },
      );

    let started = false;

    try {
      const address =
        await app.start();

      started = true;

      const worker =
        await app.service
          .registerWorker({
            name:
              "sse-stale-worker",
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
                  "GPU-SSE-STALE",
                index: 0,
                name:
                  "SSE Test GPU",
                memoryTotalMiB:
                  8192,
                memoryUsedMiB:
                  0,
                utilizationPercent:
                  0,
                temperatureC:
                  40,
                powerDrawWatts:
                  25,
              },
            ],
          });

      const existing =
        await app.database
          .listEventsAfter(0);

      const lastSequence =
        existing.at(-1)?.sequence ??
        0;

      const baseUrl =
        `http://127.0.0.1:${address.port}`;

      const response =
        await fetch(
          `${baseUrl}/v1/events`,
          {
            headers: {
              Authorization:
                `Bearer ${tokens.admin}`,
              "Last-Event-ID":
                String(
                  lastSequence,
                ),
            },
          },
        );

      assert.equal(
        response.status,
        200,
      );

      assert.match(
        response.headers.get(
          "content-type",
        ) ?? "",
        /text\/event-stream/u,
      );

      const received =
        readSseUntil(
          response,
          (event) =>
            event.type ===
              "worker.offline" &&
            event.subjectId ===
              worker.id,
        );

      now += 1_001;

      await app.schedulerRunner
        .trigger();

      const event =
        await received;

      assert.equal(
        event.type,
        "worker.offline",
      );

      assert.equal(
        event.subjectId,
        worker.id,
      );

      assert.deepEqual(
        event.payload,
        {
          reason:
            "heartbeat_timeout",
        },
      );
    } finally {
      if (started) {
        await app.stop();
      }
    }
  },
);

const connectionString =
  process.env.GPULINK_TEST_POSTGRES_URL;

test(
  "PostgreSQL events from another instance wake an HTTP SSE client",
  {
    skip:
      connectionString
        ? false
        : "GPULINK_TEST_POSTGRES_URL is not configured",
  },
  async () => {
    const writer =
      new PostgresPersistence(
        connectionString,
      );

    const listenerDatabase =
      new PostgresPersistence(
        connectionString,
      );

    let app = null;

    try {
      await writer.initialize();

      /*
       * Establish a known cursor without
       * destructively truncating the shared
       * integration-test database.
       */
      const baseline =
        await writer.appendEvent(
          "test.sse-baseline",
          `baseline-${Date.now()}`,
          {},
          Date.now(),
        );

      /*
       * Clock zero prevents this replica's
       * startup scheduler pass from treating
       * unrelated shared-test workers/jobs as
       * expired.
       */
      app =
        createControlPlane(
          config({
            database:
              "postgres",
            databaseUrl:
              connectionString,
          }),
          {
            database:
              listenerDatabase,
            clock: () => 0,
          },
        );

      const address =
        await app.start();

      const baseUrl =
        `http://127.0.0.1:${address.port}`;

      const response =
        await fetch(
          `${baseUrl}/v1/events`,
          {
            headers: {
              Authorization:
                `Bearer ${tokens.admin}`,
              "Last-Event-ID":
                String(
                  baseline.sequence,
                ),
            },
          },
        );

      assert.equal(
        response.status,
        200,
      );

      assert.match(
        response.headers.get(
          "content-type",
        ) ?? "",
        /text\/event-stream/u,
      );

      const subjectId =
        `cross-replica-${Date.now()}`;

      const received =
        readSseUntil(
          response,
          (event) =>
            event.type ===
              "test.cross-replica-sse" &&
            event.subjectId ===
              subjectId,
        );

      const written =
        await writer.appendEvent(
          "test.cross-replica-sse",
          subjectId,
          {
            source:
              "other-control-plane",
          },
          Date.now(),
        );

      const event =
        await received;

      assert.equal(
        event.sequence,
        written.sequence,
      );

      assert.equal(
        event.type,
        "test.cross-replica-sse",
      );

      assert.equal(
        event.subjectId,
        subjectId,
      );

      assert.deepEqual(
        event.payload,
        {
          source:
            "other-control-plane",
        },
      );
    } finally {
      if (app) {
        await app.stop();
      } else {
        await listenerDatabase
          .close();
      }

      await writer.close();
    }
  },
);
