# Installable GPULink CLI — public preview

**Scope:** local, Linux server and remote worker developer preview, public v0.1 preview. Linux/WSL managed local control-plane/worker commands are unchanged; Windows supports CLI configuration and diagnostics, not native managed services. Node.js 24+ and npm are required. GPU drivers and Python/model dependencies are not bundled. macOS acceptance is not yet claimed.

## Install from npm

```sh
npm install -g @gpulink/cli@0.1.0
gpulink --version
gpulink --help
```

If your npm global prefix is not user-writable, use a dedicated prefix:

```sh
npm install -g --prefix "$HOME/.local/share/gpulink-cli" @gpulink/cli@0.1.0
export PATH="$HOME/.local/share/gpulink-cli/bin:$PATH"
```

On Windows, use a user-owned npm prefix and put it on your PATH; invoke
`gpulink.cmd`. No elevation is required for npm installation. The public npm
packages and GitHub release are recorded in [release acceptance](acceptance/public-preview-2026-11-27.md).

<a name="obtain-and-verify-the-candidate"></a>

## Obtain and verify an offline candidate

The `CLI preview candidate` GitHub Actions workflow creates `gpulink-cli-candidate-<commit>` containing the versioned tarball, `SHA256SUMS` and `release.json`. Download it from a reviewed successful workflow run (both install jobs must pass). The artifact is a candidate, not a GitHub Release or npm publication. The metadata records build revision, dependency lock digest and artifact digest; these are not signatures. Verify the expected commit against the trusted workflow run and the checksum before installing. On Linux:

```sh
sha256sum -c SHA256SUMS
```

On Windows PowerShell compare `Get-FileHash .\gpulink-cli-0.1.0.tgz -Algorithm SHA256` to `SHA256SUMS` from the trusted run. Use the filename supplied by `release.json`. The root monorepo and development CLI build remain private. The explicit release build carries public registry metadata; its workflow never publishes.

For the coordinated CLI, Client SDK, Adapter SDK and .NET candidate, see
[distribution candidate installation](DISTRIBUTION_CANDIDATE.md).
The existing CLI-only download remains available.

<a name="install-outside-core"></a>

## Offline installation outside Core

From an unrelated user-owned directory, with the downloaded tarball (no source checkout and no dependency download required):

```sh
mkdir -p "$HOME/.local/share/gpulink-cli"
npm install --global --prefix "$HOME/.local/share/gpulink-cli" --offline --ignore-scripts --no-audit --no-fund /absolute/path/gpulink-cli-0.1.0.tgz
export PATH="$HOME/.local/share/gpulink-cli/bin:$PATH"
gpulink --version
gpulink --help
```

Alternatively install into a new private npm consumer project (`npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/gpulink-cli-0.1.0.tgz`) and add its `node_modules/.bin` to PATH. On Windows use PowerShell, a new user-owned npm prefix, `npm.cmd install --global --prefix <prefix>` with the same flags and an absolute tarball path, then add the prefix itself to `$env:Path`. Invoke `gpulink.cmd`. Do not use sudo or install into an existing unrelated application. Use one version per prefix; no auto-upgrade policy exists yet.

## Use the CLI

```sh
gpulink init local
gpulink doctor control-plane
gpulink doctor worker
```

These commands create a fresh private configuration and perform offline checks. They do not start services or run GPU jobs. On Linux/WSL, explicitly use `gpulink local start`, `gpulink local status`, and `gpulink local stop` for the existing localhost lifecycle. An occupied port 8088 is a refusal, not authority to stop another process. For GPU execution, consult [local lifecycle safeguards](CLI_DISTRIBUTION.md) and the explicit opt-in requirements. Do not use the local profile for remote enrollment. For an independent control-plane host with operator-managed HTTPS ingress, follow [the server preview guide](SERVER_PREVIEW.md).

## Open GPULink Manager

On Linux/WSL, from the installed CLI with the selected managed Core already running:

```sh
gpulink manager
# or explicitly select a custom/server installation
gpulink --config-dir /absolute/path/to/installation manager
# opt into local management controls
gpulink --config-dir /absolute/path/to/installation manager --enable-controls
```

The default command chooses a single existing default local or server profile. If both exist, choose explicitly with `--config-dir`. The Manager binds only to an OS-selected loopback port and prints the exact URL. It attempts to open a browser on a graphical Linux/WSL desktop; `--no-open` prints the URL only. Ctrl+C closes the Manager, not Core or workers. If the selected installation is stopped, start it explicitly using the matching `local start` or `server start` workflow. The Manager refuses unverified installation ownership and does not adopt other listeners or start services. The browser receives sanitized operational state, not Core credentials. Read-only is the default; operator mode assumes a trusted local operator. Never expose the Manager over a LAN or reverse proxy. Native Windows managed services and network-facing administration are not supported. The Manager is part of the same CLI package, not a separate Python or frontend installation.

## Remove the CLI

To uninstall the CLI, first close any running Manager, then stop the owned worker (if running), then stop the owned control plane and confirm its offline status. Remove the package using the same installation scope you originally chose:

- Normal global install: `npm uninstall -g @gpulink/cli`.
- Dedicated prefix: `npm uninstall -g --prefix "$HOME/.local/share/gpulink-cli" @gpulink/cli`. Remove the corresponding PATH addition if no longer needed.
- Private consumer project: run `npm uninstall @gpulink/cli` in that project.

This intentionally preserves instance configuration and SQLite data under `~/.gpulink/instances/` or your selected directory. Back up and remove those separately only if you no longer need them. An unknown supervisor or stale ownership record requires investigation, not force removal.

## Build and verify as a contributor

From the reviewed checkout with Node 24 and npm:

```sh
npm run build:cli:release -- data/cli-release
npm run test:cli:release -- data/cli-release
```

The build requires registry access to resolve the checked-in lockfile, uses `npm ci --ignore-scripts`, bundles runtime dependencies with the existing CLI/Core packaging boundary, and refuses an existing output directory. The same artifact is accepted by the Linux and Windows CI jobs using an empty npm cache and `--offline`. The Linux acceptance explicitly starts and stops disposable local and server control planes sequentially (requires port 8088 free and OpenSSL available); the server check uses a temporary loopback HTTPS proxy and test certificate. It does not start a worker or use a GPU. The install check validates direct invocation from unrelated directories, distinct credentials, non-overwrite, diagnostics and package removal. Existing source-built CLI/GPU acceptance commands remain available unchanged.

A build from a dirty checkout is explicitly a QA candidate (`sourceRevision: null`), not releasable. Clean reviewed CI builds identify the exact source commit. No publication, real GPU execution, real certificate issuance or cloud changes occur during candidate build. This is a versioned, locked build recipe; bit-for-bit cross-platform reproducibility, signatures, independent remote worker setup, upgrade/rollback and general availability are not certified by it.

For a separately installed Linux GPU worker, see [REMOTE_WORKER_PREVIEW.md](REMOTE_WORKER_PREVIEW.md). PR #32 records the separate guided physical acceptance. The optional [managed LAN onboarding preview](MANAGED_LAN_PREVIEW.md) automates the WSL2 NAT path after explicit opt-in; its physical acceptance is separate.
