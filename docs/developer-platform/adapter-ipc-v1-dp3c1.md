# GPULink DP3C1 — Language-neutral subprocess IPC framing

**Status:** candidate framing contract and cross-language fixture, **not wired into worker startup**, **not a safe untrusted-code sandbox**, and **not yet a stable Adapter SDK**. The current DP3B trusted in-process loader remains unchanged.

## Why a separate subprocess boundary?

DP3B's digest-verified single-file ESM loader can execute approved code in the worker process. Hash pinning establishes byte identity, not containment or publisher trust. GPULink must eventually support independently authored Python, C++, and other GPU programs without requiring their code to run in the privileged worker process. DP3C1 establishes a generic, language-neutral *framing* contract and conformance fixture before implementing the subprocess supervisor or operator installation mechanism.

## Wire format

Each frame has a **9-byte header**, followed by an opaque payload. Byte offsets: `0..3`: ASCII `GLIP`; `4`: unsigned 8-bit message kind; `5..8`: unsigned 32-bit big-endian payload length. Maximum payload: **65,536 bytes** per frame; no compression; no nested frame within frame. Byte parsing is strict and fails closed on invalid magic, kind, length, incomplete frame, or excess batching. Text and JSON are strict UTF-8. Binary frames are treated as opaque application data.

| Kind | Byte | Direction | Meaning |
|---|---:|---|---|
| HELLO | 1 | host → subprocess | Protocol version and opaque session ID (no grant, token, or worker credential) |
| READY | 2 | subprocess → host | IPC runtime handshake acknowledged, **not** model readiness |
| BINARY | 3 | both | Opaque bytes supplied by workload application |
| TEXT | 4 | both | Opaque strict UTF-8 text supplied by workload application |
| END | 5 | both | Graceful test-stream end; empty payload |
| ERROR | 6 | subprocess → host | Versioned, bounded error (details to be frozen in DP3C2) |
| CANCEL | 7 | host → subprocess | Cancellation request; empty payload |

HELLO JSON v1: `{"protocol":"gpulink.adapter.ipc","version":1,"sessionId":"opaque-session-id"}`. READY JSON v1: `{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}`. One HELLO followed by one READY is mandatory before application frames. Abrupt EOF before END is incomplete, not success; CANCEL is terminal without a success END. HELLO and READY do **not** expose or prove model readiness. Any workload-specific readiness/control messages travel *inside* regular TEXT/BINARY payloads and must have independent validation by the selected adapter.

**No implied credit ACK:** A successful write to child stdin means only that a byte sequence was queued at the OS stream. It does not mean the child decoded a frame, consumed audio, completed an inference step, or may receive additional unrestricted input. Workload-defined consumption acknowledgments are mandatory for streaming model backpressure. The future supervisor must additionally bound pending bytes and enforce per-session deadlines before enabling public use.

## DP3C1 acceptance boundary

- Test fragmentation/coalescing, binary transparency, maximum payload, malformed magic/type/length, invalid UTF-8 and truncated frames.
- Launch the independently authored stdlib Python echo fixture in an isolated test environment, send HELLO, receive READY, exchange opaque binary/text and END, assert normal exit.
- Reject invalid handshake and direction controls. Confirm no token, secret, hostname, filesystem path or GPU handles are passed to the sample.
- No package installation, no GPU inference, no worker-startup wiring, no process sandbox claims, no catalog changes.

## Explicitly deferred to DP3C2 / security gate

- Operator-controlled subprocess executable and input file digest validation; process launch restrictions; independent service account/container isolation; GPU device permissions; resource quotas (CPU, memory, VRAM, process count), filesystem/network restrictions; stdout/stderr limits; process-group termination; bounded timeouts; cancellation propagation; unexpected-exit handling; protocol direction/state enforcement; reconnect/fault policy; per-workload model readiness/consumption-credit semantics; cross-platform and Python/C++ developer packages.
- OS process separation **alone** does not confer security isolation if a child shares the worker's UID, secrets, filesystem permissions, or unrestricted GPU/network access.

This protocol is intentionally GPU-agnostic. CaptionLink's existing speech models are examples of *workload* concerns, not dependencies of GPULink IPC framing.
