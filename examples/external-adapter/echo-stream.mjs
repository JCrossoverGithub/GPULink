/** Example of an independently authored, trusted streaming-gateway adapter. */
export function createAdapter() {
  return {
    manifest: {
      schemaVersion: 2,
      type: "example.echo.streaming",
      adapterId: "example.echo.streaming.v1",
      version: "1.0.0",
      executionMode: "streaming-gateway",
    },
    async readinessProbe() { return true; },
    async handleSession(_session, { signal, dataPlaneSocket }) {
      // Demonstration only: no inference; bounded replies; fail closed.
      const socket = dataPlaneSocket;
      const onMessage = (frame, isBinary) => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 65_536) {
          socket.close(1013, "backpressure");
          return;
        }
        socket.send(frame, { binary: isBinary });
      };
      socket.on("message", onMessage);
      try {
        await new Promise((resolve) => {
          if (signal.aborted || socket.readyState !== 1) return resolve();
          const done = () => resolve();
          signal.addEventListener("abort", done, { once: true });
          socket.once("close", done);
        });
      } finally {
        socket.removeListener("message", onMessage);
      }
    },
  };
}
