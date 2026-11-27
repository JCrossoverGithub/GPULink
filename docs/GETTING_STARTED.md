# Getting started with GPULink

GPULink connects applications to GPU workers managed by an operator. Run your own
control plane and workers, or use a deployment your team has authorized you to
access. Each deployment has its own endpoint, credentials and workload catalog.

For a new local deployment, start with the [first GPU workload guide](FIRST_GPU_WORKLOAD.md).

Choose the guide for your role: [application developer](#1-application-developer--use-remote-gpu-compute),
[adapter developer](#2-adapter-developer--author-a-workload), or [GPU operator](#3-gpu-operator--provide-the-execution-environment).

The November 27 public preview provides registry-installed CLI and SDK packages.
See the [capability status matrix](CAPABILITY_STATUS.md) and
[release acceptance record](acceptance/public-preview-2026-11-27.md) for the
verified distribution and deployment boundaries.

For the November 25 installed batch preview and the guided Python author/operator
workflow, see [your first external batch workload](DEVELOPER_BATCH_QUICKSTART.md).

For offline artifacts and maintainer release verification, see
[distribution candidate installation](DISTRIBUTION_CANDIDATE.md) and
[release delivery](RELEASE_DELIVERY.md).

For a complete bounded CUDA reference application, see the
[standalone vector-search example](../examples/vector-search/README.md) and
[physical acceptance record](acceptance/independent-vector-search-2026-11-25.md).

For a local operator browser interface, see [GPULink Manager](CLI_PREVIEW_RELEASE.md#open-gpulink-manager), included in the published CLI on Linux/WSL.

The November 26 [installed two-host Manager acceptance](acceptance/installed-manager-two-host-2026-11-26.md)
verified the integrated distribution with physical CUDA and Manager drain/resume.
For an operator setting up a new cluster on the supported WSL2 NAT path, follow
[managed LAN onboarding](MANAGED_LAN_PREVIEW.md) in this order: install the
matching CLI version on both hosts; plan/apply server setup; launch Manager;
export and transfer an invitation; join on the GPU host (optionally `--name`);
review and approve the intended adapter if needed; explicitly start the worker.
Joining does not register a worker. The start step is when the GPU appears in
Manager. Application developers using an existing authorized deployment do not
need these operator steps. Manager provides a **Connect a GPU worker** guide
from Overview (empty cluster) and Workers, plus **Prepare and approve an adapter**
from Adapters. These are terminal command guides, not remote execution or
credential distribution; approval and start remain explicit local actions.

## Deployment choices

- **Run your own GPULink:** You or your organization deploy the control plane,
  enroll GPU workers, approve workloads, and issue credentials. Your applications
  connect to **your deployment's** endpoint.
- **Use a deployment operated by your team or another provider:** Install a
  supported Client SDK and obtain its endpoint, project access, and credential
  from that operator. You do not need to run Core or own a GPU just to consume
  compute that operator has authorized.
- **No automatic shared fleet:** Independent installations do not implicitly
  grant access to one another. GPULink has no universal public endpoint,
  globally shared token, or default pool of the project's GPUs.

## 1. Application developer — use remote GPU compute

**Your machine needs:** a supported client SDK, network access to **your own
GPULink deployment or one you're explicitly authorized to use**, and a
client-scoped credential. A local NVIDIA GPU,
CUDA, Docker, WSL2, and a GPULink Core checkout are **not** requirements merely
to consume an existing remote service.

**The operator of that specific GPULink deployment must provide** (or you
configure these yourself when self-hosting):

- An HTTPS origin with valid hostname/certificate trust (or HTTP loopback for
  local development only).
- A client-scoped bearer credential, delivered through a secure mechanism.
- A project identifier and an available, authorized workload capability and
  adapter identifier. These refer to an *approved workload*, not raw arbitrary
  code execution or pooled shared VRAM.

### .NET 10 (published preview)

The current independently published .NET client is
[`GPULink.Client` `0.1.0-preview.1`](../packages/gpulink-dotnet/GPULink.Client/README.md).
Install from your configured NuGet feed:

```sh
dotnet add package GPULink.Client --version 0.1.0-preview.1
```

Supply the HTTPS origin and client bearer through your application's secret
configuration, not source control. The following is a *generic lifecycle
example*: substitute a capability and adapter actually approved by your
operator. It does not define an adapter's message protocol or imply a GPU
session can be opened without an available worker.

```csharp
using GPULink.Client;

static string Required(string key) =>
    Environment.GetEnvironmentVariable(key)
    ?? throw new InvalidOperationException($"Missing {key}");

await using var client = new GPULinkClient(
    Required("GPULINK_ORIGIN"),
    Required("GPULINK_CLIENT_BEARER"));

await using var session = await client.OpenSessionAsync(
    new GPULinkSessionRequest(
        ProjectId: Required("GPULINK_PROJECT_ID"),
        Capability: Required("GPULINK_CAPABILITY"),
        Adapter: Required("GPULINK_ADAPTER_ID")));

// Wait for the selected adapter's OWN readiness signal before sending
// workload-specific frames. Relay pairing alone is not model readiness.
// Dispose/close the session even when application work fails.
```

The SDK currently targets `net10.0` and is a **preview**, not a stable v1
compatibility guarantee. See its [full README](../packages/gpulink-dotnet/GPULink.Client/README.md)
for the precise contract and limitations.

<a name="typescript--nodejs-development-sdk"></a>

### TypeScript / Node.js (published preview)

[`@gpulink/client` `0.1.0`](../packages/gpulink-sdk/README.md) provides
finite jobs, `openSession` and authenticated WebSocket relay access on Node 24+.

```sh
npm install @gpulink/client@0.1.0
```

Configure `GPULINK_BASE_URL` and `GPULINK_CLIENT_TOKEN` privately for
`GPULinkClient.fromEnv(process.env)`. See the
[batch quickstart](DEVELOPER_BATCH_QUICKSTART.md) for a complete example.

**Success for this role** means: an independent application uses only its
packaged Client SDK and an authorized endpoint, receives workload output, and
verifies remote session closure and lease/resource release. The consuming
application does not import GPULink Core or worker internals.

<a name="2-adapter-developer--implement-a-drill-bit"></a>

## 2. Adapter developer — author a workload

Adapter authors implement a workload against GPULink's versioned manifest and
GLIP process protocol. You do **not** need to modify the scheduler, HTTP server,
or .NET/TypeScript Client SDK for each application-specific workload.

The experimental [`@gpulink/adapter-sdk`](../packages/gpulink-adapter-sdk/README.md)
contains echo-profile conformance and an offline single-file packaging flow.
It is **pre-v1**. The author-side conformance CLI can test a trusted
Python echo implementation without a GPU or control plane, but currently
requires Node.js 24+ to run the test tool:

```sh
npm install @gpulink/adapter-sdk@0.1.0
npx --no-install gpulink-adapter-conformance -- python3 -I -S /absolute/path/to/echo-subprocess.py
```

Packaging produces an **operator-review candidate**, not an auto-installed
extension. The operator must independently review and authorize execution;
source hashes alone do not make a package trustworthy. Start with the
[Adapter SDK README](../packages/gpulink-adapter-sdk/README.md) and the
[operator-trusted packaging contract](developer-platform/operator-trusted-adapter-package-workflow.md).
An approved subprocess is **not an untrusted-code sandbox**.

**Success for this role** means: conformance and negative-case tests pass in an
external directory, the package can be reviewed independently, and an operator
can explicitly approve or reject it without changes to GPULink Core.

## 3. GPU operator — provide the execution environment

An operator **deploys and owns an independent GPULink installation** and
supplies its control plane, outbound GPU workers, scoped credentials, TLS
trust, adapter approval, device/runtime policies, and cleanup/monitoring.
Your deployment's endpoint and GPU capacity belong to your environment; they
are not provisioned automatically by the GPULink project.
The present production reference uses Linux/K3s/PostgreSQL, while Windows/WSL2
has been used as a development GPU host. **WSL2 is not a requirement for SDK
consumers, nor a universal production deployment prescription.**

Begin with [architecture](ARCHITECTURE.md),
[production operations](PRODUCTION_OPERATIONS.md), and
[approved adapter packaging](developer-platform/operator-trusted-adapter-package-workflow.md).
For separate hosts, use the [installed remote-worker guide](REMOTE_WORKER_PREVIEW.md) or the [managed LAN guide](MANAGED_LAN_PREVIEW.md). The [two-host design contract](INDEPENDENT_TWO_HOST_OPERATOR.md) preserves the earlier offline policy checkpoint.

### Offline configuration preflight

Install the CLI using a user-owned npm prefix (see the
[CLI installation guide](CLI_PREVIEW_RELEASE.md)), then initialize a new local
profile and validate its configuration:

```sh
npm install -g @gpulink/cli@0.1.0
gpulink init local
gpulink doctor control-plane
gpulink doctor worker
```

Each role is checked separately. The CLI validates environment
configuration and optional catalog-file readability without connecting to a
control plane, printing credential values, installing anything, or touching a
GPU. A passing result **does not** certify TLS trust, live connectivity,
physical GPU discovery, adapter integrity, or production readiness. Missing
settings produce nonzero exit codes and operator-oriented guidance.

For local development, use isolated credentials, loopback-only cleartext
services and intentional TLS termination for remote clients. Do not expose the
HTTP backend directly on a public interface, bypass certificate validation,
share administrator/worker credentials with applications, or assume trusted
subprocess execution isolates hostile workloads.

**Success for this role** means: a worker advertises an approved capability,
leases are placed and released authoritatively, and an operator can drain,
stop, restart, and recover without multiple control planes allocating the same
physical GPU.

## What has actually been proven

On October 20, 2026, a Windows laptop running CaptionLink and the published
.NET Client SDK successfully used a separate JPCMAIN RTX 3090 Ti over
HTTPS/WSS for real Multitalker caption inference. The operator observed
working captions, the session reached `closed`, assignment/lease fields were
cleared, and the isolated worker exited with no GPU compute processes
reported. **This is a proven operator-trusted two-machine integration**, not
a turnkey installation flow, universal OS/GPU support, browser-safe bearer
authentication, or multi-tenant code isolation.

## Known developer-experience gaps

- A guided, installed WSL2 LAN onboarding path is accepted with the project operator; unassisted newcomer onboarding and other network/platform paths remain outstanding.
- All three npm packages are public pre-v1 previews; stable API compatibility remains a future decision.
- The independently published .NET Client SDK is still a preview.
- Clean registry installation and adapter authoring passed with the project operator; unassisted third-party onboarding is still open.
- Reduce manual transfer, approval and onboarding friction without weakening the accepted cross-host setup/teardown or explicit execution authorization.

These remain separate engineering and adoption targets.

<a name="local-gpu-operator-preview--source-built-cli"></a>

## Local GPU operator preview — installed CLI

Install `@gpulink/cli@0.1.0` as above. See
[CLI distribution and lifecycle](CLI_DISTRIBUTION.md) for platform boundaries.
`gpulink init local` creates a private localhost configuration; it does not
start services or enroll a worker.

On Linux (including WSL), operators can deliberately start the managed
local control plane and, with `--accept-assigned-work`, a GPU worker.
A separate [repository-owned hardware acceptance](INSTALLED_LOCAL_GPU_DIAGNOSTIC_ACCEPTANCE.md)
requires explicit consent and runs one bounded NVIDIA GPU-status diagnostic,
verifying durable completion and cleanup. It is **not automatic CI**, a
remote-cluster installer, arbitrary-code execution, or a CUDA benchmark.

Application developers using an **existing authorized deployment** should
use their Client SDK and credential instead; they do not need the local
operator CLI, a GPU, Docker or WSL. The guided [managed LAN workflow](MANAGED_LAN_PREVIEW.md) is physically accepted; unassisted external developer acceptance remains open.
