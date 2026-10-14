/** GPULink public session data-plane transport. No private Core imports. */
export const GPULINK_DATA_PLANE_PROTOCOL = 'gpulink.data-plane.v1';
export const GPULINK_MAX_FRAME_BYTES = 1_048_576;
export const GPULINK_MAX_BUFFERED_BYTES = 4_194_304;

export interface DataPlaneConnectOptions {
  /** Includes WebSocket handshake and waiting for the worker to pair. Default 8s. */
  connectTimeoutMs?: number;
  /** Cancels grant acquisition, WebSocket handshake, or session pairing. */
  signal?: AbortSignal;
}

export interface DataPlaneCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type DataPlaneMessage = string | Uint8Array;

export class GPULinkDataPlane {
  readonly #socket: WebSocket;
  readonly #messageListeners = new Set<(message: DataPlaneMessage) => void>();
  readonly #closeListeners = new Set<(event: DataPlaneCloseInfo) => void>();
  #closeInfo: DataPlaneCloseInfo | null = null;

  /** @internal Created after a validated client grant and authenticated handshake. */
  constructor(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN || socket.protocol !== GPULINK_DATA_PLANE_PROTOCOL) {
      throw new Error('data-plane socket is not authenticated and open');
    }
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event: MessageEvent) => {
      const value = event.data;
      if (typeof value === 'string') {
        for (const listener of this.#messageListeners) listener(value);
      } else if (value instanceof ArrayBuffer) {
        const message = new Uint8Array(value);
        for (const listener of this.#messageListeners) listener(message);
      } else {
        this.close();
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      this.#closeInfo = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };
      for (const listener of this.#closeListeners) listener(this.#closeInfo);
      this.#messageListeners.clear();
      this.#closeListeners.clear();
    });
  }

  get isOpen(): boolean { return this.#socket.readyState === WebSocket.OPEN; }
  get closeInfo(): DataPlaneCloseInfo | null { return this.#closeInfo; }

  onMessage(listener: (message: DataPlaneMessage) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('message listener must be a function');
    if (this.#closeInfo) throw new Error('data plane is closed');
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (event: DataPlaneCloseInfo) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('close listener must be a function');
    if (this.#closeInfo) {
      listener(this.#closeInfo);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  sendBinary(frame: Uint8Array | ArrayBuffer): void {
    if (!(frame instanceof Uint8Array) && !(frame instanceof ArrayBuffer)) {
      throw new TypeError('binary frame must be Uint8Array or ArrayBuffer');
    }
    const byteLength = frame.byteLength;
    this.#beforeSend(byteLength);
    this.#socket.send(frame);
  }

  sendText(message: string): void {
    if (typeof message !== 'string') throw new TypeError('text frame must be a string');
    const byteLength = new TextEncoder().encode(message).byteLength;
    this.#beforeSend(byteLength);
    this.#socket.send(message);
  }

  #beforeSend(byteLength: number): void {
    if (!this.isOpen) throw new Error('data plane is not open');
    if (byteLength > GPULINK_MAX_FRAME_BYTES) throw new RangeError('data-plane frame exceeds 1 MiB');
    if (this.#socket.bufferedAmount + byteLength > GPULINK_MAX_BUFFERED_BYTES) {
      throw new Error('data-plane local backpressure limit exceeded');
    }
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(1000, 'client closed');
    } else if (this.#socket.readyState === WebSocket.CONNECTING) {
      try { this.#socket.close(); } catch { /* handshake still pending */ }
    }
  }
}

export function validateConnectTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(value) || value < 100 || value > 10_000) {
    throw new TypeError('connectTimeoutMs must be an integer from 100 through 10000');
  }
  return value;
}

/** Opens a grant-authenticated socket; pairing must be verified by the HTTP caller. */
export async function openDataPlaneSocket(
  baseUrl: URL,
  grant: { token: string; expiresAt: number },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GPULinkDataPlane> {
  if (!grant || typeof grant.token !== 'string' ||
      !/^gdp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.token) ||
      grant.token.length > 4096 ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new Error('invalid or expired data-plane grant');
  }
  if (timeoutMs < 1) throw new Error('data-plane connection deadline exceeded');
  signal?.throwIfAborted();

  const socketUrl = new URL('/v1/data-plane', baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket;
  try {
    socket = new WebSocket(socketUrl, [
      GPULINK_DATA_PLANE_PROTOCOL,
      `gpulink.grant.${grant.token}`,
    ]);
  } catch {
    // The WebSocket implementation may embed subprotocols in exception messages.
    throw new Error('data-plane WebSocket initialization failed');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', closed);
        if (error !== undefined) {
          // Native WebSocket.close() may reject while CONNECTING. Close on any
          // later successful open so an abandoned handshake cannot leak a live socket.
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.addEventListener('open', () => {
              try { socket.close(1000, 'connection cancelled'); } catch { /* already closed */ }
            }, { once: true });
          }
          reject(error);
        } else resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('data-plane WebSocket handshake failed'));
      const closed = () => finish(new Error('data-plane WebSocket closed during handshake'));
      const aborted = () => finish(signal?.reason ?? new Error('data-plane connection cancelled'));
      const timer = setTimeout(
        () => finish(new Error('data-plane WebSocket handshake timed out')),
        timeoutMs,
      );
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    if (socket.protocol !== GPULINK_DATA_PLANE_PROTOCOL) {
      throw new Error('data-plane subprotocol negotiation failed');
    }
    return new GPULinkDataPlane(socket);
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try { socket.close(); } catch { /* handshake not yet established */ }
    }
    throw error;
  }
}
