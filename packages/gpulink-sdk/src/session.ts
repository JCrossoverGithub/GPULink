/** Generic high-level streaming session. No workload-specific message parsing. */
import { GPULINK_MAX_BUFFERED_BYTES } from './data-plane.js';
import type { DataPlaneCloseInfo, DataPlaneMessage, GPULinkDataPlane } from './data-plane.js';

export type GPULinkSessionErrorCode =
  | 'EARLY_BUFFER_OVERFLOW'
  | 'MESSAGE_LISTENER_ERROR'
  | 'CLOSE_LISTENER_ERROR'
  | 'REMOTE_RELEASE_FAILED';

/** A bounded, credential-free client-side session diagnostic. */
export class GPULinkSessionError extends Error {
  readonly code: GPULinkSessionErrorCode;
  constructor(code: GPULinkSessionErrorCode, message: string) {
    super(message);
    this.name = 'GPULinkSessionError';
    this.code = code;
  }
}

export class GPULinkSession {
  readonly id: string;
  readonly #stream: GPULinkDataPlane;
  readonly #closeRemote: () => Promise<unknown>;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  readonly #messageListeners = new Set<(message: DataPlaneMessage) => void>();
  readonly #errorListeners = new Set<(error: GPULinkSessionError) => void>();
  readonly #errors: GPULinkSessionError[] = [];
  readonly #pending: DataPlaneMessage[] = [];
  #pendingBytes = 0;
  #flushQueued = false;
  #draining = false;

  /** @internal Constructed after allocation and authenticated relay pairing. */
  constructor(id: string, stream: GPULinkDataPlane, closeRemote: () => Promise<unknown>) {
    this.id = id;
    this.#stream = stream;
    this.#closeRemote = closeRemote;
    // Attach immediately so an unexpected socket closure does not leave its
    // authoritative GPU lease allocated until expiration. This is NOT reconnect.
    stream.onClose(() => {
      if (this.#closing) return;
      void this.close().catch(() => {
        // close() records the remote-release failure and permits retry.
      });
    });
    // A ready adapter can send its application-specific readiness frame before
    // callers subscribe. Bounded buffering is intentionally not a worker ACK.
    stream.onMessage((message) => {
      if (this.#closing) return;
      if (this.#messageListeners.size && !this.#flushQueued && !this.#draining && !this.#pending.length) {
        this.#deliver(message);
        return;
      }
      const length = typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength : message.byteLength;
      if (this.#pending.length >= 256 || this.#pendingBytes + length > GPULINK_MAX_BUFFERED_BYTES) {
        this.#report('EARLY_BUFFER_OVERFLOW', 'session inbound buffer limit exceeded; session is closing');
        void this.close().catch(() => {
          // close() separately reports an authoritative release failure.
        });
        return;
      }
      this.#pending.push(message);
      this.#pendingBytes += length;
      this.#scheduleFlush();
    });
  }

  get isOpen(): boolean { return !this.#closing && this.#stream.isOpen; }
  get protocol(): string { return this.#stream.protocol; }
  get closeInfo(): DataPlaneCloseInfo | null { return this.#stream.closeInfo; }
  /** Most recent error, including failures before the first listener subscribes. */
  get lastError(): GPULinkSessionError | null { return this.#errors.at(-1) ?? null; }
  /** Up to the last 16 generic client-side errors in emission order. */
  get errors(): readonly GPULinkSessionError[] { return this.#errors.slice(); }

  onMessage(listener: (message: DataPlaneMessage) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('message listener must be a function');
    if (this.#closing) throw new Error('session is closing');
    this.#messageListeners.add(listener);
    this.#scheduleFlush();
    return () => this.#messageListeners.delete(listener);
  }

  /** Diagnostic callbacks are isolated; late subscribers receive buffered errors. */
  onError(listener: (error: GPULinkSessionError) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('error listener must be a function');
    this.#errorListeners.add(listener);
    for (const error of this.#errors) {
      try { listener(error); } catch { /* never recursively fail diagnostics */ }
    }
    return () => this.#errorListeners.delete(listener);
  }

  #report(code: GPULinkSessionErrorCode, description: string): void {
    const error = new GPULinkSessionError(code, description);
    this.#errors.push(error);
    if (this.#errors.length > 16) this.#errors.shift();
    for (const listener of [...this.#errorListeners]) {
      try { listener(error); } catch { /* diagnostic handlers cannot break transport */ }
    }
  }

  #deliver(message: DataPlaneMessage): void {
    for (const listener of [...this.#messageListeners]) {
      if (this.#closing) return;
      try { listener(message); } catch {
        this.#report('MESSAGE_LISTENER_ERROR', 'application message listener threw');
      }
    }
  }

  #scheduleFlush(): void {
    if (!this.#messageListeners.size || !this.#pending.length || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      if (!this.#messageListeners.size || this.#closing) return;
      const pending = this.#pending.splice(0);
      this.#pendingBytes = 0;
      this.#draining = true;
      try {
        for (const message of pending) {
          if (this.#closing) break;
          this.#deliver(message);
        }
      } finally {
        this.#draining = false;
        this.#scheduleFlush();
      }
    });
  }

  onClose(listener: (event: DataPlaneCloseInfo) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('close listener must be a function');
    return this.#stream.onClose((event) => {
      try { listener(event); } catch {
        this.#report('CLOSE_LISTENER_ERROR', 'application close listener threw');
      }
    });
  }

  sendBinary(frame: Uint8Array | ArrayBuffer): void {
    if (this.#closing) throw new Error('session is closing');
    this.#stream.sendBinary(frame);
  }

  sendText(message: string): void {
    if (this.#closing) throw new Error('session is closing');
    this.#stream.sendText(message);
  }

  /**
   * Close the transport then request authoritative session release.
   * Concurrent closes share one promise; a failed remote close can be retried.
   */
  close(): Promise<void> {
    this.#closing = true;
    this.#stream.close();
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    if (!this.#closePromise) {
      this.#closePromise = Promise.resolve().then(() => this.#closeRemote()).then(
        () => undefined,
        (error: unknown) => {
          this.#closePromise = undefined;
          this.#report('REMOTE_RELEASE_FAILED', 'authoritative session release failed; call close() again');
          throw error;
        },
      );
    }
    return this.#closePromise;
  }
}
