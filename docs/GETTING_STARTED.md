# Getting started with GPULink

GPULink is open-source, self-hostable software for connecting applications
to approved GPU workloads. **There is no central, public GPULink cluster
operated by the project that everyone connects to.** Individuals, teams, and
organizations can run separate GPULink deployments with their own control
planes, GPU workers, access policies, and credentials.

A developer can deploy and operate GPULink themselves, or connect an application
to an existing deployment **only when that deployment's operator grants
access**. The project's development machines and AWS reference environment are
not a public GPU service.

**Choose your role first.** Application developers, adapter authors, and GPU
operators have different prerequisites and security responsibilities.

This guide describes the currently implemented interfaces at the GPULink
`4810e925` source checkpoint and the separately validated October 2026
cross-machine CaptionLink integration. It is **not** a promise of general
one-command installation or safe untrusted-code execution.

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

### TypeScript / Node.js (development SDK)

[`@gpulink/client` `0.1.0`](../packages/gpulink-sdk/README.md) provides
`openSession`, finite-job operations, and the authenticated v2 WebSocket relay.
At this source checkpoint it is still marked `private: true`, targets Node.js
24+, and has no accepted public npm release. Do **not** tell users to run
`npm install @gpulink/client` as if public availability were verified. Its
existing README and packaged external-consumer tests are the current
integration references.

**Success for this role** means: an independent application uses only its
packaged Client SDK and an authorized endpoint, receives workload output, and
verifies remote session closure and lease/resource release. The consuming
application does not import GPULink Core or worker internals.

## 2. Adapter developer — implement a drill bit

Adapter authors implement a workload against GPULink's versioned manifest and
GLIP process protocol. You do **not** need to modify the scheduler, HTTP server,
or .NET/TypeScript Client SDK for each application-specific workload.

The experimental [`@gpulink/adapter-sdk`](../packages/gpulink-adapter-sdk/README.md)
contains echo-profile conformance and an offline single-file packaging flow.
It is **private and pre-v1**. The author-side conformance CLI can test a trusted
Python echo implementation without a GPU or control plane, but currently
requires Node.js 24+ to run the test tool:

```sh
# From packages/gpulink-adapter-sdk in a GPULink source checkout:
node bin/conformance.mjs -- python3 -I -S /absolute/path/to/echo-subprocess.py
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

### Offline configuration preflight

From a GPULink source checkout with Node.js 24+, installed repository
dependencies, and the appropriate process-local configuration, run:

```sh
npm run cli -- doctor control-plane
npm run cli -- doctor worker
```

Each role is checked separately. The first candidate validates environment
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

- A guided operator bootstrap/worker enrollment flow is not yet accepted.
- The TypeScript and Adapter SDKs need publication and compatibility decisions.
- The independently published .NET Client SDK is still a preview.
- Independent first-use conformance should be executable from a clean external
  application directory without GPULink source imports.
- A reproducible, safe cross-host setup/teardown and diagnostics workflow must
  replace the many manual steps used in the initial integration.

Treat these as separate implementation targets. Do not invent a universal
single-command installer before deciding which role, trust boundary and host
runtime it is actually installing.

## Initialize a localhost-only GPULink deployment

For an isolated, independently owned development instance, run
`npm run cli -- init local`. See the
[local self-hosted setup guide](SELF_HOSTED_LOCAL.md) for generated
role-scoped credentials, safety boundaries, offline checks, and
deliberate startup instructions. This command does not install
dependencies, start services, or enable cross-machine access.
