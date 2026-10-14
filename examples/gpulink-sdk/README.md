# External applications using `@gpulink/client`

These examples use **only the public SDK package**; they do not import any GPULink scheduler, database, worker, or control-plane source. Install a separately built `@gpulink/client` tarball in your own Node.js 24+ ESM project, then use:

```sh
export GPULINK_BASE_URL='https://your-gpulink-control-plane.example'
export GPULINK_CLIENT_TOKEN='your-client-scoped-token'
node finite-job.mjs
node streaming-v2.mjs
```

For local loopback development, an `http://127.0.0.1:<port>` base URL is supported. Do not put client or administrator tokens into source code. **Do not use administrator tokens in the SDK.** The streaming example requires a live authorized worker that can start the allocated session and join its relay. Protocol v2 requires a v2-capable control-plane relay; existing worker-side v1 connections are compatible. The relay-ready acknowledgment confirms paired transport, not a ready inference model. Sessions are closed explicitly, and the SDK does not automatically reconnect.

`typed-consumer.ts` demonstrates the published TypeScript declarations. The existing SDK CI test `spec/external-consumer.mjs` builds a tarball, installs it into a temporary project, copies these examples there, type-checks the TypeScript consumer, and tests finite jobs and a v2 streaming session against a disposable local control plane with a synthetic worker. The harness may use private GPULink modules to create fixtures; these **application examples never do**. No npm publication or production deployment occurs.
