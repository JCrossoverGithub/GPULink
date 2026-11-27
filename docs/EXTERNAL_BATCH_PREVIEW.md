# Installed external batch workload preview (DEV-04B2)

This preview connects the existing durable job API to independently packaged,
operator-approved GLIP v1 subprocesses. No new scheduler, public HTTP endpoint,
job database schema, SDK client method or execution service is introduced.
Server and worker must be upgraded together while stopped and quiescent.

## Author and operator contract

Use a single-file adapter recipe (`gpulink.adapter.json`) as in
[`matrix-batch`](../examples/external-adapter/matrix-batch/gpulink.adapter.json).
A v2 manifest with `executionMode: "bounded-process"` must use a type in the
reserved `external.batch.` namespace, for example `external.batch.matrix`.
Choose a unique, stable type for a compatible input/output contract. One batch
implementation per type per worker is supported; placement is by type, not a
client-selected adapter ID or version. Operators must ensure the same type has
compatible behavior on different workers. Streaming `streaming-gateway`
adapters keep their existing contract. Batch capabilities cannot be used with
the session API. Bare capability-only legacy worker advertisements cannot
satisfy batch jobs; placement requires a matching ready v2 batch manifest.

Use `gpulink-adapter-package pack`, `inspect`, and `catalog` from the public preview
Adapter SDK (`npm install @gpulink/adapter-sdk@0.1.0`) to produce an offline bundle and a candidate approval catalog.
Review code and runtime before approving. The existing stopped-worker
`worker approve-catalog --file FILE --sha256 SHA256` workflow accepts batch,
streaming, or mixed catalogs. A batch spec omits `completionMode`. An optional
operator `executionLimits.sessionTimeoutMs` field reuses the existing GLIP
supervisor timeout (default 30 s, maximum 900 s including startup). A virtual
environment may require an explicitly pinned launcher as in the DEV-04A guide;
resolving a venv Python symlink can lose its dependencies. The operator owns
interpreter and native dependencies; approved source and launcher hashes are
checked before launch, but this is not a transitive dependency lock.

## Wire contract

The existing GLIP supervisor sends HELLO (with the job ID in `sessionId`).
The adapter sends the exact GLIP READY handshake. The supervisor sends one
TEXT frame containing a UTF-8 JSON object (the job payload), then empty END
and closes stdin. The adapter returns exactly one TEXT frame with a UTF-8 JSON
object, empty END acknowledgment, and exits 0. The output may precede or follow
receipt of END but must precede the END acknowledgment. No BINARY frames,
extra results, non-object JSON, or nonfinite numbers. Input and output are each
at most 32 KiB UTF-8 encoded JSON; control plane validates persisted bounds and
worker validates wire bytes. No streaming completion text is used. Invalid or
missing output, nonzero exit, timeout or failed handshake fails the job.
The supervisor waits for child close on success and failure. It passes only
LANG/LC_ALL and the assigned NVIDIA CUDA UUID, no inherited credentials.

Trusted code must execute synchronously in the supervised process, must not
spawn independent/escaping descendants or leave GPU work running after exit,
and must synchronize CUDA before reporting success. No hostile-code sandbox,
process-tree containment, hardware isolation, large artifact transfer or
exactly-once execution guarantee is claimed. The operator is responsible for
code/runtime behavior; a process exit is not proof for arbitrary programs.

## Client contract

The existing `@gpulink/client` SDK `submitJob`, `getJob`, and `cancelJob` work
unchanged. The `type` is the declared batch capability; if explicit capabilities
are supplied they must include the type. Submit returns a persistent job ID;
no continuously connected client is needed. Retrieve by ID later. For example,
use the independent `examples/gpulink-sdk/matrix-batch-client.mjs`:

```
node client.mjs submit UNIQUE_IDEMPOTENCY_KEY
node client.mjs get JOB_ID
node client.mjs verify JOB_ID
```

The example asserts actual CUDA backend result `[11,16,11,14]`, attempt 1 and
cleared lease deadline; completed job assignment IDs are retained for audit,
not active reservations. The example's `submit-hold` mode computes on CUDA
and keeps its context alive for a bounded 15-second cancellation window.
`cancel JOB_ID` uses the existing API; `get JOB_ID` retrieves terminal state.

## Acceptance and failure behavior

Physical acceptance: on independently installed server/client and remote
worker, submit a job and exit the client, retrieve result in a new process,
verify persisted worker/GPU allocation and single attempt; retrieve after a
controlled server restart. Submit the bounded hold example, verify its actual
CUDA process is running, cancel, confirm child termination and durable
cleanup hold; verify queued work is blocked on that GPU even though the job
is terminal. Drain and stop the worker, verify physical cleanup (do not rely
only on `nvidia-smi`), wait for offline, explicitly release the exact hold
using [DEV-04B1 recovery](JOB_CLEANUP_SAFETY.md), and prove normal scheduling
resumes. Never clear a database directly or bypass an unresolved hold.
Running lease expiry or cancellation never automatically replays the job.
Pre-start retry semantics are unchanged. A normal successful or failed child
exit allows ordinary terminal completion. An aborted execution does not report
success or infer cleanup attestation. The existing broker and session-specific
semantics remain separate. Automated tests use CPU subprocesses and disposable
SQLite/PostgreSQL; no unattended GPU execution.
