# DP3C3A — explicit subprocess completion and execution-isolation boundary

Status: **development candidate, not approved for production.** Maintains DP3C2B's default-disabled operator-approved subprocess catalog and unchanged scheduler, authenticated relay, IPC v1 supervisor, and public Client SDK. Does **not** add a production security sandbox.

## Opt-in completion handshake (operator/catalog level)

Catalog schema v1 entries can optionally contain `"completionMode": "explicit-text-v1"` beside `manifest` and `command`. Omitting it preserves the existing **opaque** text/binary forwarding behavior. No automatic completion is inferred from WebSocket disconnect, socket writes, subprocess `READY`, expiry, or lease cancellation.

For *only* an opt-in subprocess adapter, the host interprets the following exact UTF-8 **WebSocket text** payload as a reserved end-of-stream command:

```json
{"type":"gpulink.session.end.v1"}
```

All preceding text and binary messages are forwarded to the subprocess in order. The host then sends the IPC v1 `END` frame, awaits a valid child IPC `END` acknowledgment **and** subprocess exit with code 0, and sends this exact UTF-8 WebSocket **text** payload to the client:

```json
{"type":"gpulink.session.completed.v1"}
```

It sends completion only after the IPC supervisor has satisfied both conditions, the relay is open, and the outgoing WebSocket send callback succeeds within a bounded 2-second limit. This is a **subprocess completion acknowledgment**, not confirmation that the client application consumed the acknowledgment, not a model-ready signal, not a model-result accuracy claim, and not authoritative GPULink session closure. Clients must still call the authenticated session close endpoint or the Client SDK's `close()` to release the allocation. A WebSocket close does not count as success.

No other data is treated as infrastructure control, and binary frames are always opaque. Frames received after the reserved END are rejected and the subprocess cancelled. The reserved completion payload is rejected when supplied by a client or echoed by a subprocess, preventing simple spoofing of the worker acknowledgment. The control strings are deliberately **not** a general-purpose user-data envelope and must be treated as reserved only for adapters that opt into the feature. The feature is not active for DP3B trusted-JS adapters or legacy unconfigured subprocess adapters.

A future language-specific Client SDK may provide `end()` and typed completion events; this candidate does **not** add such methods or modify the data-plane wire protocol. The existing SDK can call `session.sendText('{"type":"gpulink.session.end.v1"}')` only when the chosen adapter advertises/supports this opt-in contract.

## Security reality and DP3C3B hard acceptance requirements

**SHA-256 approval + a sanitized subprocess environment is not sandboxing**. The current bridge still launches an approved executable as the worker's user and is suitable only for *operator-trusted* development/test fixtures. It is NOT enabled for untrusted third-party workloads or production GPU workers. Known limitations include same-UID filesystem and `/proc` access, network access, dynamic-library/import dependency integrity, parent-directory and exec-time races, subprocess descendants, resource exhaustion, and unrestricted GPU device scope.

DP3C3B's isolation backend must be **default-deny and testable as a separate operator-approved execution mode**, not a flag that claims bare `spawn()` is isolated. Acceptance requirements:

1. Require an explicit, policy-verified rootless OCI/container runtime (or a comparably isolated runtime) for third-party programs; fail closed if unavailable or policy does not apply. No raw host executables as the untrusted execution path.
2. Restrict CPU, memory, PID count, runtime duration, writable storage, Linux capabilities, syscalls, privilege escalation, and network access. Use read-only rootfs; mount only content-addressed, operator-approved assets read-only; do **not** mount Docker/Podman sockets or GPULink credentials.
3. Run with a dedicated non-root identity and disjoint worker secrets/filesystem permissions; audit `/proc`, Unix sockets and device visibility. Preserve secret-free, constrained child env and no shell invocation.
4. Use operator-pinned immutable OCI image digests and a locked dependency closure. Verify image/runtime provenance and exact command. Avoid host interpreter/script path TOCTOU, and review other included dependencies and shared libraries.
5. Ensure cancellation and worker shutdown terminate all container processes, not only the direct child, and prevent successful completion if cleanup is not confirmed.
6. Keep GPU exposure explicitly denied until per-adapter GPU access can be constrained and validated with NVIDIA container runtime/CUDA device policy. A fake-GPU test does not establish secure GPU passthrough.
7. Test escape attempts, network isolation, process exhaustion, descendant lifetime, file access, shutdown races, and refusal to start when policy is missing, as well as positive IPC and client-completion behavior.

These gates require actual container/host security support and operator review. They cannot be inferred from the unit tests in DP3C3A. In particular, an adapter's data-plane `READY` does not indicate that a GPU model is loaded or ready.

## Acceptance for DP3C3A only

- Exact 32-path DP3C2B source baseline and no changes to scheduler, worker lifecycle, Client SDK, or IPC protocol.
- Existing default opaque mode unaffected. Opt-in input is exact, framed by the WebSocket's text/binary distinction.
- Completed subprocess requires child IPC END ACK, exit zero, and bounded WebSocket write completion, not premature child success or disconnect.
- No success on malformed input, unauthorized catalog metadata, spoofed completion payload, missing END, nonzero child exit, or socket failure.
- Python subprocess unit tests, fake-GPU worker+control-plane+authenticated relay E2E, complete root regressions and complete Client SDK tests on JPCMAIN.
- No installations, production deployment, model inference, commits, pushes or merges.
