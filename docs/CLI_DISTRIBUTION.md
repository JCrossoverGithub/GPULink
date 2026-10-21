# GPULink CLI preview — package and configuration contract

**Status:** source-built, private local-installation preview. Not an npm
registry release, OS installer, production service supervisor,
or automatic hardware setup.

## Roles and boundaries

- `gpulink` is the operator/developer **CLI**, not a requirement for an
  application integrating through the separately versioned Client SDKs.
- This preview `@gpulink/cli` tarball contains the matching GPULink Core
  runtime source (`src/`), so local smoke does not depend on the GPULink
  repository existing on the machine where the CLI was installed.
- The source repository root remains `private: true`. Build output is staged
  under Git-ignored `data/cli-artifacts/`; `npm publish` is never run.
- Node.js 24 or newer is required. This is not a standalone native executable.

## Build and install from source (explicit, no publication)

In a clean GPULink checkout:

```sh
npm ci
npm run build:cli
```

The build produces a tarball in `data/cli-artifacts/`, typically
`gpulink-cli-0.1.0.tgz`. Install **that** tarball in a separate, empty
consumer directory with npm:

```sh
mkdir -p /tmp/gpulink-cli-consumer
npm install --prefix /tmp/gpulink-cli-consumer ./data/cli-artifacts/gpulink-cli-0.1.0.tgz
/tmp/gpulink-cli-consumer/node_modules/.bin/gpulink --version
/tmp/gpulink-cli-consumer/node_modules/.bin/gpulink --help
```

On Windows use a private consumer directory and the npm-generated
`node_modules\\.bin\\gpulink.cmd` shim. This is an installer acceptance
candidate, not a globally published command yet. To invoke `gpulink` by name,
place the consumer directory's `node_modules/.bin` on your `PATH` or install
the tarball to a user-owned npm prefix. **Do not elevate privileges.**

## Configuration discovery (local preview only)

- `gpulink init local` creates a new private installation at
  `~/.gpulink/instances/local`, independent of the current directory and CLI
  package installation directory. If it exists, creation refuses to overwrite.
- `gpulink --config-dir /absolute/private/path init local` creates at that
  path. `gpulink init local /absolute/private/path` is also accepted.
- `gpulink doctor control-plane`, `doctor worker`, `workers`, `jobs` and
  `local smoke --real-gpu` discover the default installation if present.
- `gpulink --config-dir /absolute/private/path doctor worker` selects a
  different **generated local** installation. When the CLI uses one of these
  setups, it refuses inherited conflicting profile environment values.
- To interact with a non-local GPULink deployment, keep using explicit
  `GPULINK_URL` / scoped credentials for now; `--config-dir` currently only
  accepts the generated localhost profile contract, not arbitrary production
  configuration files.
- Existing `data/self-hosted-local` installations are **not moved or modified**.
  Pass their absolute path through `--config-dir`, or as the legacy final
  argument to `local smoke`.

No command automatically starts services, runs GPU work, allocates a GPU,
creates credentials, or changes AWS merely by being installed.
`local smoke --real-gpu` remains explicitly opt-in, creates only temporary
owned service processes, and retains SQLite state. See
[SELF_HOSTED_LOCAL.md](SELF_HOSTED_LOCAL.md).

## External acceptance before registry release

From **outside the source tree** on both supported developer OSes: install
the tarball, invoke the npm-generated CLI executable, verify `--help` and
`--version`, initialize and doctor a private setup, and (on an opted-in
physical GPU host) run the bounded diagnostic smoke. Test refusal to reuse an
existing setup, unknown profiles, inherited conflicting credentials, and
occupied port. Document architecture/hardware support accurately; do not
conflate CLI portability with native GPU worker support.

Publishing, compatibility policy, signing/provenance, upgrade/recovery,
non-local installation support, and production-grade service supervision
remain separate future milestones. A Linux-only developer preview is described below.

## Read-only local status (single-machine development)

`gpulink local status` observes the default generated localhost setup. Use
`gpulink --config-dir /absolute/private/path local status` to select another.
The operation is **credential-free and read-only**: it does not send admin,
worker, or client secrets to the network and never starts any process or GPU
work. This avoids leaking credentials to an unrelated service occupying port 8088.

The JSON fields distinguish `controlPlane` (`offline`,
`ready-response-unverified`, or `unverified`), `localWorker` (`unknown`),
and `processOwnership` (`unverified`). A plausible `/readyz` response is
**not** proof of GPULink identity. Offline is an observational success;
unknown or responding-but-unverified endpoints cause a nonzero exit code.

This is only the safe observation foundation. Verified worker health and
Managed Linux lifecycle status uses a private supervisor IPC channel
as described below. This is not general production supervision. It is not
remote GPU enrollment or a network-cluster deployment command.

## Installation-scoped process-record inspection (read-only foundation)

The `ownershipRecords` object in `gpulink local status` reports any candidate
records under the selected installation's private `run/` directory. It reports
`absent`, `invalid`, `stale`, `unverifiable`, or
`birth-matches-unverified` for each service role. **Every classification has
`authority: "none"`.** It does not read another installation's records,
contact a management socket, send a credential, or signal a process.

The v1 record contract binds a service role to the selected installation's
secret-derived fingerprint, PID, Linux boot ID and kernel process start ticks.
Records are size-bounded, schema-strict, and reject symlinks or unsafe POSIX
permissions. A PID and matching kernel birth time are only an untrusted
candidate, **not** sufficient proof that a process belongs to GPULink.
These records alone cannot authorize shutdown; the Linux preview below
adds an installation-private supervisor IPC channel. Windows lacks a validated
kernel-birth probe in this increment,
so existing records there remain `unverifiable` and cannot authorize action.

This feature does not create ownership records or automatically enroll workers;
it is a contract and read-only inspection foundation for future lifecycle
management. Local smoke remains independently owned and temporary.


## Linux managed control-plane lifecycle preview

`gpulink local start`, `gpulink local status`, and `gpulink local stop`
are an **opt-in single-machine development workflow** in Linux (including
WSL). These three commands manage **only the local control plane**; separate worker commands are documented below.
`start` launches a detached, installation-owned supervisor; the supervisor
alone owns the control-plane child process. The CLI verifies installation
identity and Linux kernel process birth metadata, then communicates through
a private Unix-domain socket. `stop` never sends a signal to a PID parsed
from a file: it asks that supervisor to gracefully terminate its own child.
There is no custom cryptographic challenge-response protocol here. The
protection is an installation-private directory, Unix socket permissions,
verified birth metadata, a per-launch identifier, and supervision of a
direct child. This does **not** defend against a malicious process already
running under the same operating-system account.

Stale/corrupt owner records, symlinked runtime state, lock contention,
and unknown sockets fail closed; records are **not** automatically deleted.
Do not delete state or signal a PID without examining the situation.
Status remains credential-free. A managed control plane is reported as
`ready-managed-local` with `processOwnership: managed-local`; unrecognized
listeners remain unverified. The original `ownershipRecords` object remains
non-authoritative. An unexpected control-plane exit is not treated as success.

**Linux-only initial acceptance.** Windows `local start` and `local stop`
fail closed pending a separately validated Windows-native ownership and
permission implementation. `local smoke --real-gpu` is unchanged. Remote
GPU worker enrollment, multi-machine clusters, production supervision,
and service auto-start at boot remain separate features. CLI packaging
remains private; nothing is published or deployed automatically.

## Linux lifecycle reliability and recovery

The Linux/WSL developer preview uses a **shared exclusive lifecycle lock**
for both `local start` and `local stop`. Contending commands refuse to run;
neither command steals or automatically removes a stale lock. A lock left
behind by an interrupted operation requires operator investigation.

The supervisor captures the filesystem identity (device, inode, mode) of
its own private socket and owner record. On graceful shutdown it only
removes a path when that identity still matches. Replaced or tampered
runtime objects are preserved for investigation rather than deleted.

If the detached supervisor crashes or is killed abruptly, its child might
remain running without a trustworthy supervisor. In that case, `local
status` must not report it as managed and `local stop` must refuse to
signal a PID taken from disk. This preview does not automatically adopt
or terminate orphaned services. Inspect the runtime and running service
before any manual recovery; do not delete owner records merely because a
PID is absent or a Unix socket is unresponsive. A process that survives a
supervisor crash may still occupy port 8088.

The lifecycle retains the Linux-only, control-plane-only boundary. It
is **not** a production service manager, crash-proof daemon, or Windows
lifecycle implementation. Remote worker enrollment remains a separate milestone.

## Linux managed local GPU worker preview

The installed CLI can explicitly manage one GPU worker using the **same
installation-owned Linux supervisor** and `run/start.lock` shared with the
control plane. No Windows service-management permission is inferred.

```sh
gpulink --config-dir /private/local/instance local start
gpulink --config-dir /private/local/instance local worker start --accept-assigned-work
gpulink --config-dir /private/local/instance local status
gpulink --config-dir /private/local/instance local worker stop
gpulink --config-dir /private/local/instance local stop
```

**Starting an actual worker can execute already-queued GPU jobs or adapter
sessions.** `local worker start` therefore refuses unless the operator
supplies the explicit `--accept-assigned-work` flag. Merely installing,
configuring, checking status, or running the automated PR acceptance script
does not start a worker or exercise the physical GPU. The worker uses only
the generated local worker credential and localhost URL. It does not add
remote worker enrollment or network trust rules. Tests do not start a real
GPU worker without a separate, explicit operator action.

The worker has its own `worker.owner.json` and private `worker.sock`, with
verified supervisor process birth and installation binding. The supervisor
alone owns the worker child handle. `local worker stop` requests graceful
shutdown through that verified private IPC channel, and never signals a
PID from a file. `local stop` refuses while any worker ownership record or
IPC socket remains, so shutdown order is worker then control plane.
Unknown or stale worker records and interrupted supervisor state must be
investigated manually; no automatic process adoption, record deletion, or
unverified signal is authorized. This remains a local developer preview,
not a production host orchestrator.
