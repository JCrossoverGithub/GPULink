# Public preview distribution acceptance — November 27, 2026

Release: [GPULink 0.1.0 Public Preview](https://github.com/JCrossoverGithub/GPULink/releases/tag/gpulink-v0.1.0-preview.1).
Source: `e1406c0ec98f43f15d93705d7666f0a51a2b2931` (PR #51 merge).
Main [CI](https://github.com/JCrossoverGithub/GPULink/actions/runs/46038155909)
and [distribution workflow](https://github.com/JCrossoverGithub/GPULink/actions/runs/46038155835)
completed successfully, including Linux/Windows install jobs and main delivery.

The operator verified the delivered archive and inner checksums, then published
its three npm tarballs. Anonymous registry requests returned version 0.1.0,
`latest` and `preview` tags, matching SHA-512 integrity metadata, and identical
bytes. SHA-256 values of those bytes:

| Package | SHA-256 |
| --- | --- |
| @gpulink/cli | `f8204ec45294f90793d477be8022b25f5432f2929b01cdfc0a095e0f9737d2e1` |
| @gpulink/client | `b670658073f8850d523825661ea30db0095dfa9c2175c6d961050ed1c737f950` |
| @gpulink/adapter-sdk | `cea5a53e4be6614dca9e108f05d7243ac63f76c15ad51dab78b0e31f80fcef1d` |

An isolated WSL consumer with a fresh npm cache, empty npm configuration and
separate home/prefix installed all three public packages. CLI version/help,
local initialization, offline control-plane doctor, both SDK imports and
adapter starter generation, packaging and inspection passed. This was
operator-guided registry installation, not an unassisted external developer
trial or a new live GPU test. The matching candidate's cross-platform runtime
acceptance ran in CI; earlier physical tests retain their own revisions.

The existing GitHub draft's previous assets were backed up and replaced with
the accepted delivery archive and checksum, downloaded and compared before
publication. The remote release tag resolved to the source revision above.
Publication completed at 2026-11-27T17:16:36Z. The npm tarballs and Git tag are immutable release records; subsequent repository documentation improvements do not alter their bytes. The build-time candidate manifest
is retained unchanged. Its .NET candidate is separate from the already
published `GPULink.Client` 0.1.0-preview.1 NuGet package and is not asserted to
match that registry artifact byte-for-byte.


## Registry-installed physical GPU acceptance

A subsequent R4.2 documentation acceptance exercise on November 27, 2026,
used the published GPULink 0.1.0 CLI on JPCMAIN (WSL).

- Published CLI integrity matched the accepted release.
- Fresh managed control plane started with an empty job queue.
- Explicitly authorized worker registered one NVIDIA GeForce RTX 3090 Ti.
- Scheduled diagnostic: `job_52296e09354946858067507d626673a4`.
- Scheduler assignment, worker and authoritative diagnostic result agreed.
- Worker and control plane stopped gracefully.
- Completed job was retrieved after restarting the control plane.
- Final shutdown was confirmed and the disposable installation removed.

This validates registry-installed GPU discovery, scheduling, diagnostic
execution, durable SQLite persistence and managed lifecycle cleanup.
It is not a CUDA compute benchmark or an unassisted external developer trial.

The R4.2 registry documentation acceptance also passed the extracted README
and batch examples against mock HTTP, adapter package creation and inspection,
operator-review catalog preparation, and registry-based vector-search setup.
No adapter execution was authorized by those documentation tests.
