# GPULink CLI preview — package and configuration contract

**Status:** source-built, private local-installation preview. Not an npm
registry release, OS installer, process supervisor, production deployment,
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
non-local installation support, and persistent local service supervision
remain separate future milestones.

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
authenticated status require a trusted service-ownership protocol, which is
needed before adding persistent `local start` and `local stop`. It is not
remote GPU enrollment or a network-cluster deployment command.
