# .NET Client SDK packaging contract — candidate

This document describes a **candidate**, not an issued GPULink release.

## Separation of responsibilities

- **GPULink:** owns `GPULink.Client`, its public client protocol, API, NuGet metadata,
  tests, and package provenance.
- **Adapter authors:** implement independently approved workload adapters using the Adapter SDK.
- **Application authors (e.g. CaptionLink):** consume a versioned GPULink Client SDK
  using normal NuGet dependency resolution; they do not need the GPULink source checkout.
- **Operators:** approve GPUs, execution policies, worker/adapter catalogs, and credentials.
  SDK packaging never activates or approves an adapter.

## Candidate package

- Package ID: `GPULink.Client`
- Candidate version: `0.1.0-preview.1`
- Current TFM: `net10.0`
- Package license: the unmodified repository `LICENSE` file (no inferred SPDX identifier).
- README: `packages/gpulink-dotnet/GPULink.Client/README.md`
- CI: offline .NET contract tests on Ubuntu and Windows, NuGet pack, package contents
  verification, and a downloadable CI artifact on Ubuntu.
- No publishing, release tagging, feed credentials, or external deployment from CI.

## Validation and release policy

1. Keep the package separate from any application-specific code or physical GPU configuration.
2. Require the SDK contract tests and package validator to pass on CI.
3. Prove a consumer can build from a fresh checkout using the packaged SDK and a controlled feed.
4. Select an accessible, authenticated or public distribution channel deliberately before
   replacing development-only project references in external repositories.
5. Pin the consumer to a reviewed package version, define update/compatibility policy,
   and ensure CI and release workflows restore the exact package.
6. Separately review API stability, package ID availability, security, release ownership,
   and signing/provenance policy **before** any public publication.

The CI package is a validation artifact and must not be treated as a published release.
