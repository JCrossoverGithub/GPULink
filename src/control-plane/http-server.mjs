import http from "node:http";
import { URL } from "node:url";
import { ValidationError } from "../shared/validation.mjs";

const MAX_BODY_BYTES = 1_048_576;

export function createHttpServer({ service, database, scheduler }) {
  const eventClients = new Set();

  let unsubscribeEventNotifications =
    null;

  const server = http.createServer(async (request, response) => {
    const requestStartedAt = Date.now();
    try {
      const url = new URL(request.url, "http://control-plane.local");

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        await database.counts();
        return sendJson(response, 200, { status: "ready" });
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        if (!authorize(service, request, response, ["admin"])) return;
        return sendMetrics(response, await database.counts());
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        if (!authorize(service, request, response, ["admin"])) return;
        return await openEventStream(request, response, database, eventClients);
      }

      if (request.method === "POST" && url.pathname === "/v1/workers/register") {
        if (!authorize(service, request, response, ["worker"])) return;
        const worker = await service.registerWorker(await readJson(request));
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { worker });
      }

      if (request.method === "GET" && url.pathname === "/v1/workers") {
        if (!authorize(service, request, response, ["admin"])) return;
        return sendJson(response, 200, { workers: await database.listWorkers() });
      }

      const workerHeartbeat = matchPath(url.pathname, "/v1/workers/:id/heartbeat");
      if (request.method === "POST" && workerHeartbeat) {
        if (!authorize(service, request, response, ["worker"])) return;
        const worker = await service.heartbeatWorker(workerHeartbeat.id, await readJson(request));
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { worker });
      }

      const workerDrain = matchPath(url.pathname, "/v1/workers/:id/drain");
      if (request.method === "POST" && workerDrain) {
        if (!authorize(service, request, response, ["admin"])) return;
        const worker = await service.setWorkerDrain(workerDrain.id, await readJson(request));
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { worker });
      }

      const workerLeases = matchPath(url.pathname, "/v1/workers/:id/leases");
      if (request.method === "GET" && workerLeases) {
        if (!authorize(service, request, response, ["worker"])) return;
        if (!await database.getWorker(workerLeases.id)) {
          return sendJson(response, 404, { error: { code: "not_found", message: "worker not found" } });
        }
        const jobs = (await database.listJobs({ workerId: workerLeases.id, limit: 100 }))
          .filter((job) => job.status === "leased" || job.status === "running");
        return sendJson(response, 200, { jobs });
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs") {
        if (!authorize(service, request, response, ["client"])) return;
        const result = await service.submitJob(
          await readJson(request),
          request.headers["idempotency-key"],
        );
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, result.duplicate ? 200 : 201, result);
      }

      if (request.method === "GET" && url.pathname === "/v1/jobs") {
        if (!authorize(service, request, response, ["client"])) return;
        const status = url.searchParams.get("status");
        const limit = parseLimit(url.searchParams.get("limit"));
        return sendJson(response, 200, { jobs: await database.listJobs({ status, limit }) });
      }

      const jobPath = matchPath(url.pathname, "/v1/jobs/:id");
      if (request.method === "GET" && jobPath) {
        if (!authorize(service, request, response, ["client"])) return;
        const job = await database.getJob(jobPath.id);
        return job
          ? sendJson(response, 200, { job })
          : sendJson(response, 404, { error: { code: "not_found", message: "job not found" } });
      }

      const jobStart = matchPath(url.pathname, "/v1/jobs/:id/start");
      if (request.method === "POST" && jobStart) {
        if (!authorize(service, request, response, ["worker"])) return;
        const job = await service.startJob(jobStart.id, await readJson(request));
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { job });
      }

      const jobRenew = matchPath(url.pathname, "/v1/jobs/:id/renew");
      if (request.method === "POST" && jobRenew) {
        if (!authorize(service, request, response, ["worker"])) return;
        const job = await service.renewJob(jobRenew.id, await readJson(request));
        return sendJson(response, 200, { job });
      }

      const jobFinish = matchPath(url.pathname, "/v1/jobs/:id/finish");
      if (request.method === "POST" && jobFinish) {
        if (!authorize(service, request, response, ["worker"])) return;
        const job = await service.finishJob(jobFinish.id, await readJson(request));
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { job });
      }

      const jobCancel = matchPath(url.pathname, "/v1/jobs/:id/cancel");
      if (request.method === "POST" && jobCancel) {
        if (!authorize(service, request, response, ["client"])) return;
        const job = await service.cancelJob(jobCancel.id);
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, { job });
      }

      if (request.method === "POST" && url.pathname === "/v1/scheduler/run") {
        if (!authorize(service, request, response, ["admin"])) return;
        const result = await scheduler.runOnce();
        await broadcastNewEvents(database, eventClients);
        return sendJson(response, 200, result);
      }

      sendJson(response, 404, { error: { code: "not_found", message: "route not found" } });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      const code = statusCode === 500 ? "internal_error" : error.name
        .replace(/Error$/u, "")
        .replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)
        .replace(/^_/u, "");
      if (statusCode === 500) console.error(error);
      sendJson(response, statusCode, {
        error: {
          code,
          message: statusCode === 500 ? "internal server error" : error.message,
        },
      });
    } finally {
      const elapsedMs = Date.now() - requestStartedAt;
      if (elapsedMs > 1_000) {
        console.warn(JSON.stringify({ event: "slow_request", method: request.method, url: request.url, elapsedMs }));
      }
    }
  });

  server.startEventNotifications =
    async () => {
      if (
        unsubscribeEventNotifications
      ) {
        return;
      }

      unsubscribeEventNotifications =
        await database
          .subscribeToEvents(
            () =>
              broadcastNewEvents(
                database,
                eventClients,
              ),
          );
    };

  server.stopEventNotifications =
    async () => {
      const unsubscribe =
        unsubscribeEventNotifications;

      unsubscribeEventNotifications =
        null;

      if (unsubscribe) {
        await unsubscribe();
      }
    };

  server.closeEventStreams =
    () => {
      for (
        const client of eventClients
      ) {
        client.response.end();
      }

      eventClients.clear();
    };

  server.on("close", () => {
    server.closeEventStreams();
  });

  return server;
}

function authorize(service, request, response, allowedScopes) {
  if (service.authenticate(request.headers.authorization, allowedScopes)) return true;
  response.setHeader("WWW-Authenticate", "Bearer");
  sendJson(response, 401, {
    error: { code: "unauthorized", message: "valid bearer token required" },
  });
  return false;
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new ValidationError("request body exceeds 1 MiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("request body must contain valid JSON");
  }
}

function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function matchPath(actualPath, pattern) {
  const actual = actualPath.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return null;
  const values = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(":")) {
      values[expected[index].slice(1)] = decodeURIComponent(actual[index]);
    } else if (expected[index] !== actual[index]) {
      return null;
    }
  }
  return values;
}

function parseLimit(value) {
  if (value === null) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ValidationError("limit must be an integer from 1 through 500");
  }
  return parsed;
}

async function openEventStream(
  request,
  response,
  database,
  clients,
) {
  const lastEventId = Number(
    request.headers["last-event-id"] ?? 0,
  );

  const client = {
    response,
    sequence:
      Number.isSafeInteger(lastEventId)
        ? lastEventId
        : 0,
    flushTail: Promise.resolve(),
  };

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  response.write("retry: 2000\n\n");

  clients.add(client);

  await queueClientFlush(
    database,
    client,
  );

  const keepAlive =
    setInterval(
      () =>
        response.write(
          ": keepalive\n\n",
        ),
      15_000,
    );

  request.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(client);
  });
}

async function broadcastNewEvents(
  database,
  clients,
) {
  await Promise.all(
    [...clients].map(
      (client) =>
        queueClientFlush(
          database,
          client,
        ),
    ),
  );
}

function queueClientFlush(
  database,
  client,
) {
  const next =
    client.flushTail.then(
      () =>
        flushClient(
          database,
          client,
        ),
    );

  client.flushTail = next.then(
    () => undefined,
    () => undefined,
  );

  return next;
}

async function flushClient(
  database,
  client,
) {
  const events =
    await database.listEventsAfter(
      client.sequence,
    );

  for (const event of events) {
    client.response.write(
      `id: ${event.sequence}\n`,
    );

    client.response.write(
      `event: ${event.type}\n`,
    );

    client.response.write(
      `data: ${JSON.stringify(event)}\n\n`,
    );

    client.sequence = event.sequence;
  }
}

function sendMetrics(
  response,
  {
    workerCounts,
    jobCounts,
  },
) {
  const lines = [
    "# HELP gpulink_workers Number of registered workers by state.",
    "# TYPE gpulink_workers gauge",
    ...["online", "offline"].map(
      (status) =>
        `gpulink_workers{status="${status}"} ${workerCounts[status] ?? 0}`,
    ),
    "# HELP gpulink_jobs Number of jobs by lifecycle state.",
    "# TYPE gpulink_jobs gauge",
    ...[
      "queued",
      "leased",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ].map(
      (status) =>
        `gpulink_jobs{status="${status}"} ${jobCounts[status] ?? 0}`,
    ),
    "",
  ];

  const body =
    Buffer.from(lines.join("\n"));

  response.writeHead(200, {
    "Content-Type":
      "text/plain; version=0.0.4; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });

  response.end(body);
}
