/** Client-scoped GPULink v1 HTTP SDK. No imports from private Core modules. */
import { GPULinkDataPlane, openDataPlaneSocket, validateConnectTimeout } from './data-plane.js';
export { GPULinkDataPlane, GPULINK_DATA_PLANE_PROTOCOL, GPULINK_MAX_FRAME_BYTES, GPULINK_MAX_BUFFERED_BYTES } from './data-plane.js';
export type { DataPlaneConnectOptions, DataPlaneCloseInfo, DataPlaneMessage } from './data-plane.js';
export type JsonObject = Record<string, unknown>;
export interface JobSubmission {
  projectId: string;
  type: string;
  priority?: number;
  constraints?: {
    gpuCount?: number;
    minVramMiB?: number;
    capabilities?: string[];
  };
  payload?: JsonObject;
  maxAttempts?: number;
}
export interface SessionRequest {
  schemaVersion?: 1;
  projectId: string;
  capability: string;
  priority?: number;
  requirements?: {
    gpuCount?: 1;
    minVramMiB?: number;
    capabilities?: string[];
    model?: string | null;
    adapter?: string | null;
  };
  metadata?: JsonObject;
  recovery?: { maxInterruptions?: number };
}
export interface JobRecord { id: string; status: string; [key: string]: unknown }
export interface SessionRecord { id: string; status: string; [key: string]: unknown }
export interface ClientGrant { token: string; expiresAt: number }
export interface ListOptions { status?: string; limit?: number }
export interface SubmitOptions { idempotencyKey?: string }
export interface GPULinkClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}
export class GPULinkApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GPULinkApiError';
    this.status = status;
    this.code = code;
  }
}
export class GPULinkClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  constructor(options: GPULinkClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('client options required');
    const url = new URL(options.baseUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new TypeError('HTTPS required except for loopback development');
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new TypeError('baseUrl must be an origin without credentials, path, query, or fragment');
    }
    if (typeof options.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.token)) {
      throw new TypeError('a nonempty bearer token without whitespace is required');
    }
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
      throw new TypeError('timeoutMs must be 1..120000');
    }
    this.#baseUrl = url;
    this.#token = options.token;
    this.#timeoutMs = timeout;
  }
  submitJob(body: JobSubmission, options: SubmitOptions = {}): Promise<{ job: JobRecord; duplicate: boolean }> {
    return this.#request('POST', '/v1/jobs', body, options);
  }
  async getJob(id: string): Promise<{ job: JobRecord }> {
    return this.#request('GET', `/v1/jobs/${part(id)}`);
  }
  async listJobs(options: ListOptions = {}): Promise<{ jobs: JobRecord[] }> {
    return this.#request('GET', `/v1/jobs${query(options)}`);
  }
  async cancelJob(id: string): Promise<{ job: JobRecord }> {
    return this.#request('POST', `/v1/jobs/${part(id)}/cancel`, {});
  }
  requestSession(body: SessionRequest, options: SubmitOptions = {}): Promise<{ session: SessionRecord; duplicate: boolean }> {
    return this.#request('POST', '/v1/sessions', body, options);
  }
  async getSession(id: string): Promise<{ session: SessionRecord }> {
    return this.#request('GET', `/v1/sessions/${part(id)}`);
  }
  async listSessions(options: ListOptions = {}): Promise<{ sessions: SessionRecord[] }> {
    return this.#request('GET', `/v1/sessions${query(options)}`);
  }
  async closeSession(id: string): Promise<{ session: SessionRecord }> {
    return this.#request('POST', `/v1/sessions/${part(id)}/close`, {});
  }
  async requestClientGrant(id: string): Promise<{ grant: ClientGrant }> {
    return this.#request('POST', `/v1/sessions/${part(id)}/data-plane/client-grant`);
  }
  /** Obtain a short-lived grant; return only after a worker pairs and session becomes active. */
  async connectSession(id: string, options: { connectTimeoutMs?: number } = {}): Promise<GPULinkDataPlane> {
    const timeoutMs = validateConnectTimeout(options.connectTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const { grant } = await this.requestClientGrant(id);
    const stream = await openDataPlaneSocket(this.#baseUrl, grant, deadline - Date.now());
    try {
      for (;;) {
        if (!stream.isOpen) throw new Error('data-plane socket closed before session became active');
        if (Date.now() >= deadline) throw new Error('data-plane peer activation timed out');
        const { session } = await this.getSession(id);
        if (session.status === 'active') {
          // The relay commits activation before linking peer sockets; avoid sending immediately.
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (!stream.isOpen) throw new Error('data plane closed during pairing');
          return stream;
        }
        if (session.status !== 'allocated' && session.status !== 'connecting') {
          throw new Error('session is no longer eligible for data-plane activation');
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, deadline - Date.now()))));
      }
    } catch (error) {
      stream.close();
      throw error;
    }
  }
  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: SubmitOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey !== undefined) {
      const key = options.idempotencyKey;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) {
        throw new TypeError('invalid idempotency key');
      }
      headers['Idempotency-Key'] = key;
    }
    const response = await fetch(new URL(path, this.#baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = object(payload) ? payload.error : null;
      const code = object(error) && typeof error.code === 'string' ? error.code : 'http_error';
      const message = object(error) && typeof error.message === 'string'
        ? error.message : `GPULink returned HTTP ${response.status}`;
      throw new GPULinkApiError(response.status, code, message);
    }
    if (!object(payload)) throw new Error('GPULink returned a non-object JSON response');
    return payload as T;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function part(id: string): string {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new TypeError('id must be a nonempty string');
  return encodeURIComponent(id);
}
function query(options: ListOptions): string {
  const params = new URLSearchParams();
  if (options.status !== undefined) {
    if (typeof options.status !== 'string' || !options.status) throw new TypeError('invalid status');
    params.set('status', options.status);
  }
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) {
      throw new TypeError('limit must be an integer from 1 through 500');
    }
    params.set('limit', String(options.limit));
  }
  return params.size > 0 ? `?${params}` : '';
}
