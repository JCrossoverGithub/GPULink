# GPULink Adapter SDK — external conformance candidate

**Status: DP1/DP3 development candidate, not a published or stable v1 Adapter SDK.**

This initial, dependency-free author tool checks the existing **GLIP v1
Python echo profile**, independently of GPULink Core imports. It does not
introduce another worker runtime, manifest version, scheduler contract,
transport, or dependency on Node for adapter programs. The CLI uses Node only
as a developer-side testing tool; Python/C++ adapters implement the documented
language-neutral framing contract themselves.

## Try an adapter in an external directory

Copy `examples/external-adapter/echo-subprocess.py` into your *own* directory,
then run the following from this package directory with a trusted Python
executable on PATH (for example `python3`):

```sh
node bin/conformance.mjs -- python3 -I -S /absolute/path/to/your/echo-subprocess.py
```

Six positive and negative checks cover opaque binary, UTF-8, END, bad initial
message, incompatible version, premature EOF and cancellation. All probes use
fresh processes and a bounded 3-second timeout; the tool passes no GPULink
credentials or control-plane configuration. **Never use this CLI to run
untrusted executable code.** It is not a sandbox or a safety validator.

Run `node --test spec/echo-conformance.test.mjs` to test this candidate kit.
This package is intentionally marked `private: true` pending v1 contract and
release review. The existing operator-approved catalog remains the way an
operator configures an adapter for the worker.

## Exact existing protocol boundaries

- `GLIP` 9-byte header; 4-byte magic, 1-byte kind, 4-byte BE length; max
  65,536-byte payload. See `docs/developer-platform/adapter-ipc-v1-dp3c1.md`.
- HELLO v1 must precede READY v1; READY means IPC handshake, **not** a loaded
  model. BINARY and TEXT are application-defined and generally **do not**
  have to echo. Echo semantics apply **only to this example profile**.
- END acknowledgement plus exit 0 is specific to this profile. Workload
  completion and consumption acknowledgments are not inferred from receipt or
  write buffering. CANCEL and abrupt EOF are never successful completion.
- Adapter `schemaVersion: 2` is unchanged; operator catalog v1 and its hashes
  are handled by the existing trusted-loader code. This tool neither authors
  nor automatically installs or approves a catalog entry.
- Operator trust, pinned dependency closure, process-tree/GPU cleanup,
  isolation, independent GPU-backed workload proof and SDK publishing remain
  separate unaccepted DP3 criteria.
