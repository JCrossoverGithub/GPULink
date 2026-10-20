# Initialize an independent, local GPULink deployment

This is an **operator-owned, localhost-only development setup**, not a hosted
GPULink service, cross-machine deployment, production installer, or an approval
to run arbitrary code. The setup generator requires Node.js 24+ and a GPULink
source checkout. It does **not** install dependencies, start processes, expose
ports, enroll GPUs, modify an existing environment, or create a cloud account.

## Generate your own configuration

From the GPULink repository root, run:

```sh
npm ci
npm run cli -- init local
```

This creates `data/self-hosted-local/`, ignored by Git, containing four separate
profiles:

- `control-plane.env`: localhost/SQLite settings and four independently generated
  secrets. **Keep this on the control-plane host.**
- `worker.env`: a worker-scoped token and loopback control-plane URL.
- `client.env`: the client-scoped token and URL.
- `admin.env`: the admin-scoped token and URL. Protect this profile as carefully
  as the control-plane configuration.

The directory must not already exist; repeat invocations refuse to overwrite
it. On POSIX systems it is created mode `0700` with profile files mode `0600`.
On Windows, Node.js permissions do not certify NTFS ACL isolation: store the
folder in a private user-owned location and restrict its ACLs before use. Do not
move or commit these profiles into shared directories or paste their contents
into logs or support requests.

To use a different directory (also new and private):

```sh
npm run cli -- init local /absolute/private/path
```

**The loopback address is deliberate.** `127.0.0.1` is accessible only on the
same host/network namespace. Do not replace it with a public non-TLS endpoint.
Each independent operator generates and owns their credentials; no shared
GPULink endpoint or project-operated GPU fleet is involved.

## Verify configuration offline

From the repo root, with no conflicting inherited `GPULINK_*` variables:

```sh
node --env-file=data/self-hosted-local/control-plane.env src/cli/main.mjs doctor control-plane
node --env-file=data/self-hosted-local/worker.env src/cli/main.mjs doctor worker
```

Node's `--env-file` **does not override pre-existing environment variables**.
If you have previously exported GPULink credentials or endpoint settings,
remove them from your shell/session before running anything. Do not combine
this private setup with existing production credentials or worker processes.

## Start locally (deliberate, separate action)

Only after checking that the configuration targets an isolated localhost
instance and that the default port 8088 is free, you may run these in separate
terminals from the repo root (again, with no conflicting inherited GPULink env):

```sh
node --env-file=data/self-hosted-local/control-plane.env src/control-plane/main.mjs
node --env-file=data/self-hosted-local/worker.env src/worker/main.mjs
```

The worker requires functional GPU discovery on its host for real GPU work; a
correct configuration file does not establish driver, device, adapter, model,
or workload readiness. This setup does **not** enable third-party executable
adapters. It is intentionally limited to trusted, operator-approved workloads.

For a local CLI consumer, use only the client-scoped profile:

```sh
node --env-file=data/self-hosted-local/client.env src/cli/main.mjs jobs
```

Stop services with SIGINT/SIGTERM when finished. State is stored in
`data/self-hosted-local/control-plane.sqlite`. Do not confuse a successful
startup with production acceptance. Before deploying across machines, the
operator must configure a trusted HTTPS origin, certificate validation,
service supervision, persistent storage and recovery, worker GPU runtime,
credential distribution and rotation, firewall rules, and approved adapters.
The local generator **does not** implement that cross-machine deployment path.

## Verify the full local GPU lifecycle

Once an independent installation has been initialized, a **deliberately opt-in**
real-GPU smoke test can start the local control plane and worker, register a
physical GPU, schedule exactly one trusted `diagnostic.gpu-status` job, verify
its persisted completion and worker events, and shut down **only** the two
processes it started:

```sh
npm run cli -- local smoke --real-gpu
```

An optional final argument selects another already initialized private setup
folder: `npm run cli -- local smoke --real-gpu /path/to/setup`.

The command validates all four generated profiles and their credential scopes,
requires `127.0.0.1:8088` and the setup's SQLite path, and refuses an occupied
port. It never connects to the project's AWS or any other GPULink installation.
It does not create credentials or databases in other locations, run arbitrary
adapters, or perform cloud provisioning. The database is **retained**, including
prior job history; use a fresh installation if you require an empty history.
The worker must be able to discover a physical GPU. `--real-gpu` is required
so CI and development tooling do not accidentally use a GPU.

For Windows, verify that the setup directory has private NTFS ACLs first; Node
file modes alone cannot establish ACL safety. This is a **localhost development
acceptance** flow, not a production startup/stop supervisor or a cross-machine
installer. Real workload capability and secure remote deployment require
separate setup and operator approval.
