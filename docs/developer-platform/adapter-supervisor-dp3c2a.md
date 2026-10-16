# GPULink DP3C2A — bounded standalone subprocess supervisor (candidate)

**Gate:** DP3C1 accepted; DP3C2A is a separately tested candidate. It **does not** change `WorkerAgent`, worker startup, the DP3B operator catalog, scheduler, relaying, public Client SDK, CaptionLink, or CUDA inference. The supervisor is not installed or enabled by default. Only conformance tests explicitly launch the Python fixture.

## Intended division of responsibility

- GPULink worker host eventually owns operator approval, session identity, lease cancellation, process supervision, relay framing and resource accounting.
- Independent adapter subprocesses own workload parsing, model loading/readiness, and real consumed-work acknowledgments. All application frames remain opaque to GPULink IPC.
- DP3C2A adds `src/worker/adapter-subprocess-supervisor.mjs` and an opt-in `startAdapterSubprocess()` entry point, **not** an executable approval or security sandbox.

## Contract

`startAdapterSubprocess({ executable, args, sessionId, onFrame, signal?, startupTimeoutMs?, sessionTimeoutMs?, terminateGraceMs? })` returns a handle with `ready`, `completed`, `sendBinary(bytes)`, `sendText(text)`, `end()`, `cancel()` and read-only `state`.

- `executable` **must be an absolute path**; arguments and session ID are bounded. The caller, not the client, must supply *operator-approved* paths. DP3C2A does **not** verify executable or argument file SHA-256 or installation trust yet; DP3C2B must implement that before worker wiring.
- `spawn()` uses no shell. Child environment is limited to `LANG=C`, `LC_ALL=C`; parent tokens, DB URLs, and credentials are not inherited in environment variables. Other channels such as same-UID files or network are **not** isolated.
- A versioned HELLO is sent to stdin. `ready` resolves only for one strict `READY` IPC handshake (`gpulink.adapter.ipc`, version 1, ready true). This is **process protocol readiness**, not model readiness.
- `onFrame` is a required *synchronous* handler for BINARY/TEXT frames; its exception fails the session closed without exposing application error text. Buffering is in Node streams, not an unlimited userspace queue. Slow or blocking callbacks remain an integration hazard.
- `sendBinary()` and `sendText()` support one bounded IPC frame per call and cap outstanding write bytes. Resolution of a write means **only queued into stdin**, never decoded by the child or consumed by GPU inference. The workload must define its own consumption credits/ACKs.
- `end()` sends END after previously queued writes; already in-flight output may precede END acknowledgement. `completed` resolves only if the child returns a final empty END and exits successfully (exit code 0). Child EOF, wrong direction, premature END, invalid framing, or invalid UTF-8 fail closed.
- `cancel()` and external `AbortSignal` fail the session, request SIGTERM and escalate to SIGKILL after a short deadline. The IPC CANCEL frame is best effort. Cancellation cannot become success. This kills only the immediate child, **not** a process tree.

## Hard bounds in DP3C2A

- IPC framing: 65,536-byte payload cap, strict v1 header/UTF-8, max 64 frames per individual decode batch (inherited DP3C1).
- Child stdout total: **16 MiB**. Emitted frame count: **8,192**. Child stderr total: **8 KiB**, with all stderr discarded rather than displayed or stored.
- Queued child stdin writes: **256 KiB**. Startup deadline default 2 seconds (max 60 seconds); total session deadline default 30 seconds (max 5 minutes). SIGTERM→SIGKILL default 150 ms (10–5000 ms).
- These conservative conformance limits are not yet general-purpose production settings. Resource limits and throughput policies must become explicitly operator-configured as part of a future hardening gate.

## Safety and acceptance

Run opt-in unit/integration tests against an external stdlib Python fixture. Test happy-path HELLO/READY/BINARY/TEXT/END, malformed READY and direction, child failure/EOF, stdout/stderr bounds, startup and runtime deadlines, synchronous listener failure, external abort, and parent environment sanitization. No GPU inference or model downloads.

**DP3C2A does not provide untrusted-code isolation:** A same-user child can still access same-user files, network, and OS resources. Before enabling operator-supplied subprocess adapters in workers, DP3C2B must establish immutable catalog approval, argument-file hashes, no TOCTOU loading, worker credential isolation, restricted UID/namespace/container strategy, child process-group termination, and an authenticated end-to-end relay test. No production deployment may use this candidate as a security boundary.
