# DEV-06 — independent vector-search acceptance (2026-11-25 Eastern)

## Accepted distribution

- Source revision: `6220a093d5a70abd8d735df2d51163315dc67090` (PR #40).
- Main CI: 45726625833; distribution workflow: 45726625883.
- Four-package distribution and outer/inner checksum verification passed.
- No new public registry or GitHub Release publication was performed.
- The [standalone example](../../examples/vector-search/README.md) preserves the tested application kit. Its preparation instructions describe the original pre-acceptance gate; this record supplies the subsequent outcome.

## Physical acceptance

A two-host, operator-guided deployment used the accepted installed CLI and SDK archives, not Core source imports. The application and control plane ran on one host; a separate Linux/WSL2 NVIDIA worker ran the reviewed custom Python workload. Both client installations passed all five application tests (including mock HTTP integration). The author used the Adapter SDK starter, pack, inspect and prepare-python commands; the operator explicitly approved the generated catalog before starting the worker. The portable workload digest was `0ca0e20442f5780792b5a7b31f3b88daf8170ab7b05ef682f82af0137f84ba7c`.

- Capability: `external.batch.vector-search`; adapter `external.batch.vector-search.v1`, version 1.0.0; execution mode `bounded-process`; reported ready.
- GPU: NVIDIA GeForce RTX 3090 Ti, 24564 MiB reported inventory.
- Job: `job_31bf7a7601e24ab39697092cb399405d`; first submission not a duplicate.
- Submit process exited; a separate invocation retrieved the terminal result, then another read the persisted job record.
- Terminal state `succeeded`, attempt 1, backend `pytorch-cuda`, metric `inner-product`, assigned worker and GPU recorded.
- Independent integer reference matched exactly: audio 95, video 93, render 88.
- Worker drained and stopped; control plane stopped gracefully with SQLite retained; relevant listeners, Windows port forwarding and GPULink firewall rule removed.

No Core runtime changes were needed. This is evidence of one bounded custom CUDA application, not a performance benchmark, general GPU compatibility, hostile-code sandbox, external newcomer trial, or restart/recovery test. The final job read preceded shutdown; no post-restart persistence test was performed in DEV-06.

## Developer experience findings

Independent package install, workload scaffolding, operator catalog generation and SDK submission/retrieval worked. A missing unzip utility on the client host required Python's ZIP extraction; manual secure invitation transfer and network/admin setup remain operator work. The application was authored and exercised by the project team, not an unrelated developer. Public distribution, signed provenance, automatic upgrades and independent external developer acceptance remain separate gates. The next planned milestone is the visual operations manager, building on the existing read-only dashboard rather than replacing Core authority.
