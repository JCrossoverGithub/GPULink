export class ControlPlaneClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  registerWorker(body) {
    return this.request("POST", "/v1/workers/register", body);
  }

  heartbeat(workerId, body) {
    return this.request("POST", `/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, body);
  }

  leases(workerId) {
    return this.request("GET", `/v1/workers/${encodeURIComponent(workerId)}/leases`);
  }

  startJob(jobId, body) {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/start`, body);
  }

  renewJob(jobId, body) {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/renew`, body);
  }

  finishJob(jobId, body) {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/finish`, body);
  }

  async request(method, path, body = undefined) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const content = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(content.error?.message || `control plane returned HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = content.error?.code;
      throw error;
    }
    return content;
  }
}
