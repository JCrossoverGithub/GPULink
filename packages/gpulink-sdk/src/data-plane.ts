/** GPULink public session data-plane transport. No private Core imports. */
export const GPULINK_DATA_PLANE_PROTOCOL = 'gpulink.data-plane.v1';
export const GPULINK_DATA_PLANE_PROTOCOL_V2 = 'gpulink.data-plane.v2';
export const GPULINK_RELAY_READY_V2 = 'gpulink.relay.ready.v2';
export type DataPlaneProtocolVersion = 1 | 2;
export const GPULINK_MAX_FRAME_BYTES = 1_048_576;
export const GPULINK_MAX_BUFFERED_BYTES = 4_194_304;

export interface DataPlaneConnectOptions {
  /** Includes WebSocket handshake and waiting for the worker to pair. Default 8s. */
  connectTimeoutMs?: number;
  /** Cancels grant acquisition, WebSocket handshake, or session pairing. */
  signal?: AbortSignal;
  /** v1 remains the default until server v2 rollout; opt in explicitly with 2. */
  protocolVersion?: DataPlaneProtocolVersion;
}

export interface DataPlaneCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type DataPlaneMessage = string | Uint8Array;

export class GPULinkDataPlane {
  readonly #socket: WebSocket;
  readonly #protocol: string;
  #earlyMessages: DataPlaneMessage[];
  readonly #messageListeners = new Set<(message: DataPlaneMessage) => void>();
  readonly #closeListeners = new Set<(event: DataPlaneCloseInfo) => void>();
  #closeInfo: DataPlaneCloseInfo | null = null;

  /** @internal Created after a validated client grant and authenticated handshake. */
  constructor(socket: WebSocket, protocol: string = GPULINK_DATA_PLANE_PROTOCOL, earlyMessages: DataPlaneMessage[] = []) {
    if (socket.readyState !== WebSocket.OPEN ||
        ![GPULINK_DATA_PLANE_PROTOCOL, GPULINK_DATA_PLANE_PROTOCOL_V2].includes(protocol) ||
        socket.protocol !== protocol) {
      throw new Error('data-plane socket is not authenticated and open');
    }
    this.#socket = socket;
    this.#protocol = protocol;
    this.#earlyMessages = earlyMessages;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event: MessageEvent) => {
      const value = event.data;
      if (typeof value === 'string') {
        if (this.#protocol === GPULINK_DATA_PLANE_PROTOCOL_V2 && value === GPULINK_RELAY_READY_V2) {
          this.close(); // Duplicate relay control frames must not reach application listeners.
          return;
        }
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
  get protocol(): string { return this.#protocol; }
  get closeInfo(): DataPlaneCloseInfo | null { return this.#closeInfo; }

  onMessage(listener: (message: DataPlaneMessage) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('message listener must be a function');
    if (this.#closeInfo) throw new Error('data plane is closed');
    this.#messageListeners.add(listener);
    if (this.#earlyMessages.length) {
      const queued = this.#earlyMessages;
      this.#earlyMessages = [];
      queueMicrotask(() => {
        if (!this.#messageListeners.has(listener) || this.#closeInfo) return;
        for (const message of queued) listener(message);
      });
    }
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
    if (this.#protocol === GPULINK_DATA_PLANE_PROTOCOL_V2 && message === GPULINK_RELAY_READY_V2) {
      throw new Error('reserved relay control frame may not be sent by a client');
    }
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

/** Opens a grant-authenticated socket; v2 waits for the server-origin ready frame. */
export async function openDataPlaneSocket(
  baseUrl: URL,
  grant: { token: string; expiresAt: number },
  timeoutMs: number,
  signal?: AbortSignal,
  protocolVersion: DataPlaneProtocolVersion = 1,
): Promise<GPULinkDataPlane> {
  if (!grant || typeof grant.token !== 'string' ||
      !/^gdp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.token) ||
      grant.token.length > 4096 ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new Error('invalid or expired data-plane grant');
  }
  if (timeoutMs < 1) throw new Error('data-plane connection deadline exceeded');
  validateProtocolVersion(protocolVersion);
  signal?.throwIfAborted();

  const socketUrl = new URL('/v1/data-plane', baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const requiredProtocol = protocolVersion === 2
    ? GPULINK_DATA_PLANE_PROTOCOL_V2 : GPULINK_DATA_PLANE_PROTOCOL;
  let socket: WebSocket;
  try {
    socket = new WebSocket(socketUrl, [
      requiredProtocol,
      `gpulink.grant.${grant.token}`,
    ]);
    // Capture any binary frame before the relay ready-ACK as an ArrayBuffer.
    socket.binaryType = 'arraybuffer';
  } catch {
    // The WebSocket implementation may embed subprotocols in exception messages.
    throw new Error('data-plane WebSocket initialization failed');
  }
  try {
    const earlyMessages: DataPlaneMessage[] = [];
    let earlyBytes = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let openedOk = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('message', message);
        if (error !== undefined) {
          // Native WebSocket may disallow close() while still connecting.
          // If the abandoned socket opens later, close it immediately.
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.addEventListener('open', () => {
              try { socket.close(1000, 'connection cancelled'); } catch { /* already closed */ }
            }, { once: true });
          }
          reject(error);
        } else resolve();
      };
      const opened = () => {
        if (socket.protocol !== requiredProtocol) {
          finish(new Error('data-plane subprotocol negotiation failed; no downgrade permitted'));
          return;
        }
        openedOk = true;
        if (protocolVersion === 1) finish();
      };
      const message = (event: MessageEvent) => {
        if (protocolVersion !== 2 || !openedOk) {
          finish(new Error('data-plane frame before valid protocol negotiation'));
          return;
        }
        if (event.data === GPULINK_RELAY_READY_V2) {
          finish();
          return;
        }
        // A worker may send an application frame after relay pairing but before
        // the ready frame is observed. Preserve it, bounded, for the first listener.
        const frame = event.data;
        if (typeof frame !== 'string' && !(frame instanceof ArrayBuffer)) {
          finish(new Error('unexpected data-plane frame before relay readiness'));
          return;
        }
        const bytes = typeof frame === 'string' ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
        if (bytes > GPULINK_MAX_FRAME_BYTES || earlyBytes + bytes > GPULINK_MAX_BUFFERED_BYTES) {
          finish(new Error('data-plane pre-readiness buffer limit exceeded'));
          return;
        }
        earlyBytes += bytes;
        earlyMessages.push(typeof frame === 'string' ? frame : new Uint8Array(frame));
      };
      const failed = () => finish(new Error('data-plane WebSocket handshake/ready failed'));
      const closed = () => finish(new Error('data-plane WebSocket closed before relay readiness'));
      const aborted = () => finish(signal?.reason ?? new Error('data-plane connection cancelled'));
      const timer = setTimeout(
        () => finish(new Error('data-plane WebSocket handshake/relay readiness timed out')),
        timeoutMs,
      );
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', closed);
      if (protocolVersion === 2) socket.addEventListener('message', message);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    if (socket.protocol !== requiredProtocol) {
      throw new Error('data-plane subprotocol negotiation failed; no downgrade permitted');
    }
    return new GPULinkDataPlane(socket, requiredProtocol, earlyMessages);
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try { socket.close(); } catch { /* handshake not yet established */ }
    }
    throw error;
  }
}

/** Explicit protocol opt-in. Reject unexpected versions without contacting Core. */
export function validateProtocolVersion(value: unknown): DataPlaneProtocolVersion {
  if (value !== 1 && value !== 2) throw new TypeError('protocolVersion must be 1 or 2');
  return value;
}
