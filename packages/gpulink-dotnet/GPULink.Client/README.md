# GPULink.Client

The general-purpose .NET 10 client SDK for GPULink's GPU workload session protocol.

It is independent of individual adapters and applications such as CaptionLink. It handles
control-plane session allocation and the supported streaming/session lifecycle contracts.

## Prerequisites

- .NET 10 SDK to build, and a GPULink control plane to use the client at runtime.
- A configured and authorized GPULink environment for remote execution.

## Installation

`GPULink.Client 0.1.0-preview.1` is an early .NET 10 preview. Once the
version is listed on NuGet.org, install it in your .NET project:

```sh
dotnet add package GPULink.Client --version 0.1.0-preview.1
```

For builds that must use this **exact** version, add this to your project file:

```xml
<PackageReference Include="GPULink.Client" Version="[0.1.0-preview.1]" />
```

The square brackets specify an exact NuGet version constraint. Do not switch
a downstream application to this dependency until that version is retrievable
from its configured feed.

## Minimal C# example

```csharp
using GPULink.Client;

static string Required(string name) =>
    Environment.GetEnvironmentVariable(name)
    ?? throw new InvalidOperationException($"Missing {name}");

await using var client = new GPULinkClient(
    Required("GPULINK_ORIGIN"),
    Required("GPULINK_CLIENT_BEARER"));

await using var session = await client.OpenSessionAsync(
    new GPULinkSessionRequest(
        ProjectId: "example-project",
        Capability: "example.capability",
        Adapter: "example.approved.adapter"));

// Consult the approved adapter's protocol to handle workload readiness,
// send input frames, receive results, and establish completion.
// Disposing the session closes its remote GPULink allocation.
```

Replace the example identifiers with those approved by your GPULink
deployment. An authorized GPULink control plane, client credentials, and an
available workload adapter are required; installing this SDK does not provide
a running GPU cluster.

## Preview limitations

- Public APIs and protocol requirements can change before a stable release.
- Session requests currently allocate one GPU at a time.
- Automatic interruption recovery is not enabled in this preview.
- GPULink relay readiness is distinct from adapter/model readiness.
- Workload-specific message framing, completion, and error handling belong
  to the consuming application and its approved adapter contract.

The local SDK contract runner is:

```sh
dotnet run --project packages/gpulink-dotnet/GPULink.Client.ContractTests/GPULink.Client.ContractTests.csproj -c Release
```

## Scope and compatibility

This package provides the generic .NET Client SDK only. It does **not** bundle GPULink Core,
workers, approved adapter assets, CUDA code, or CaptionLink. The current target framework is
`net10.0`; no other target frameworks or stable compatibility guarantees are claimed.

Source, documentation, and issues: https://github.com/JCrossoverGithub/GPULink
