/** Client-scoped GPULink v1 HTTP SDK. No imports from private Core modules. */
import { GPULinkDataPlane, openDataPlaneSocket, validateConnectTimeout, validateProtocolVersion } from './data-plane.js';
export { GPULinkDataPlane, GPULINK_DATA_PLANE_PROTOCOL, GPULINK_DATA_PLANE_PROTOCOL_V2, GPULINK_RELAY_READY_V2, GPULINK_MAX_FRAME_BYTES, GPULINK_MAX_BUFFERED_BYTES } from './data-plane.js';
import type { DataPlaneConnectOptions } from './data-plane.js';
import { GPULinkSession } from './session.js';
export { GPULinkSession, GPULinkSessionError } from './session.js';
export type { GPULinkSessionErrorCode } from './session.js';
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
/** High-level client session acquisition. Only generic lifecycle, not model readiness. */
export interface OpenSessionOptions {
  /** Cancels placement wait and data-plane connection; setup cleanup remains best-effort. */
  signal?: AbortSignal;
  /** Time to wait for a worker to start a newly created session. Default 30s. */
  allocationTimeoutMs?: number;
  /** Grant + authenticated relay pairing deadline. Default 8s, maximum 10s. */
  connectTimeoutMs?: number;
  /** Stable caller-supplied idempotency key for HTTP session creation. */
  idempotencyKey?: string;
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
  /**
   * Request a GPU capability and connect through the authenticated v2 relay.
   * This waits for worker activation but NOT application/model readiness.
   * It deliberately does not retry, reconnect, or interpret adapter payloads.
   */
  async openSession(body: SessionRequest, options: OpenSessionOptions = {}): Promise<GPULinkSession> {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    const allocationTimeoutMs = options.allocationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(allocationTimeoutMs) || allocationTimeoutMs < 100 || allocationTimeoutMs > 120_000) {
      throw new RangeError('allocationTimeoutMs must be 100..120000');
    }
    const connectTimeoutMs = validateConnectTimeout(options.connectTimeoutMs);
    options.signal?.throwIfAborted();

    // Do not abort session creation mid-response: the server may have created a
    // session whose ID we could no longer discover and close. Creation remains
    // subject to the SDK's normal HTTP timeout. Once an ID is known, we own it.
    const created = await this.requestSession(body, { idempotencyKey: options.idempotencyKey });
    const id = created.session?.id;
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('GPULink session creation did not return a valid ID');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('session allocation deadline exceeded')), allocationTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let stream: GPULinkDataPlane | undefined;
    try {
      // Grant issuance before connecting/active is correctly rejected by Core.
      // Do not try to bypass that contract by retrying grant failures.
      for (;;) {
        signal.throwIfAborted();
        const { session } = await this.getSession(id, { signal });
        signal.throwIfAborted();
        if (session.status === 'connecting' || session.status === 'active') break;
        if (!['requested', 'allocated', 'interrupted'].includes(session.status)) {
          throw new Error('session ended before worker activation');
        }
        await waitForPairing(100, signal);
      }
      // The allocation deadline covers this connect attempt as well, while
      // the transport retains its existing stricter connectTimeoutMs cap.
      stream = await this.connectSession(id, {
        protocolVersion: 2,
        connectTimeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (!stream.isOpen) throw new Error('data plane closed before session became usable');
      return new GPULinkSession(id, stream, () => this.closeSession(id));
    } catch (error) {
      stream?.close();
      try {
        // Cleanup is intentionally not tied to the caller's aborted signal.
        await this.closeSession(id);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'session setup failed and cleanup failed');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async getSession(id: string, options: { signal?: AbortSignal } = {}): Promise<{ session: SessionRecord }> {
    return this.#request('GET', `/v1/sessions/${part(id)}`, undefined, options);
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
  /** Obtain a client grant and wait for relay pairing within a single deadline. */
  async connectSession(id: string, options: DataPlaneConnectOptions = {}): Promise<GPULinkDataPlane> {
    const timeoutMs = validateConnectTimeout(options.connectTimeoutMs);
    const protocolVersion = validateProtocolVersion(options.protocolVersion === undefined ? 1 : options.protocolVersion);
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    options.signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('data-plane connection deadline exceeded')),
      timeoutMs,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let stream: GPULinkDataPlane | undefined;
    try {
      // All HTTP requests, the handshake, and v2 readiness share this deadline.
      const { grant } = await this.#request<{ grant: ClientGrant }>(
        'POST', `/v1/sessions/${part(id)}/data-plane/client-grant`, undefined, { signal },
      );
      signal.throwIfAborted();
      stream = await openDataPlaneSocket(this.#baseUrl, grant, deadline - Date.now(), signal, protocolVersion);
      if (protocolVersion === 2) {
        // Explicit relay ACK occurs after authorization, activation, and pairing.
        signal.throwIfAborted();
        if (!stream.isOpen) throw new Error('data-plane closed after relay readiness');
        return stream;
      }
      for (;;) {
        signal.throwIfAborted();
        if (!stream.isOpen) throw new Error('data-plane socket closed before session became active');
        const { session } = await this.#request<{ session: SessionRecord }>(
          'GET', `/v1/sessions/${part(id)}`, undefined, { signal },
        );
        signal.throwIfAborted();
        if (session.status === 'active') {
          // Legacy v1 has no readiness ACK; preserve its compatibility delay.
          await waitForPairing(30, signal);
          signal.throwIfAborted();
          if (!stream.isOpen) throw new Error('data plane closed during pairing');
          return stream;
        }
        if (session.status !== 'allocated' && session.status !== 'connecting') {
          throw new Error('session is no longer eligible for data-plane activation');
        }
        await waitForPairing(Math.min(40, Math.max(1, deadline - Date.now())), signal);
      }
    } catch (error) {
      stream?.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: SubmitOptions & { signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted();
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
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(this.#timeoutMs)])
        : AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
    });
    const payload: unknown = await response.json().catch(() => null);
    options.signal?.throwIfAborted();
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

/** Interruptible delay used only by the session pairing loop. */
function waitForPairing(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, delayMs);
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
