# GPULink.Client

The general-purpose .NET 10 client SDK for GPULink's GPU workload session protocol.

It is independent of individual adapters and applications such as CaptionLink. It handles
control-plane session allocation and the supported streaming/session lifecycle contracts.

## Prerequisites

- .NET 10 SDK to build, and a GPULink control plane to use the client at runtime.
- A configured and authorized GPULink environment for remote execution.

## Dependency

The candidate version is `0.1.0-preview.1`. **It is not published to a public NuGet feed.**
For evaluation, build a NuGet package from this repository and provide a local package source:

```sh
dotnet pack packages/gpulink-dotnet/GPULink.Client/GPULink.Client.csproj -c Release -o ./artifacts/nuget
```

After the package is placed in a NuGet feed available to your build, reference an **exact version**:

```xml
<PackageReference Include="GPULink.Client" Version="[0.1.0-preview.1]" />
```

The square brackets are an exact NuGet version constraint, not a minimum-version request.
Do not switch external applications to this dependency until the selected version is actually
available from their configured package source and validated by CI.

The local SDK contract runner is:

```sh
dotnet run --project packages/gpulink-dotnet/GPULink.Client.ContractTests/GPULink.Client.ContractTests.csproj -c Release
```

## Scope and compatibility

This package provides the generic .NET Client SDK only. It does **not** bundle GPULink Core,
workers, approved adapter assets, CUDA code, or CaptionLink. The current target framework is
`net10.0`; no other target frameworks or package publication channels are claimed yet.

See `docs/sdk/dotnet-client-package.md` for the proposed release process and current gates.
