# Coordinated distribution candidate (DEV-05A)

GPULink's existing `CLI preview candidate` workflow builds a **private, nonpublished candidate** from one Git revision. The four packages remain separate products. The combined artifact is a convenient delivery and validation unit, not a combined runtime, universal installer, or registry release.

| Package | Candidate version | Purpose and prerequisites |
| --- | --- | --- |
| `@gpulink/cli` | `0.1.0` | CLI and matching Core; Node.js 24+, npm; Linux/WSL managed services, Windows CLI configuration/diagnostics |
| `@gpulink/client` | `0.1.0` | TypeScript/JavaScript client; Node.js 24+, npm |
| `@gpulink/adapter-sdk` | `0.1.0` | Workload authoring and package review tools; Node.js 24+, npm; Python runtime separately supplied |
| `GPULink.Client` | `0.1.0-preview.1` | Native .NET session client; .NET 10 |

The npm package names and versions above are internal candidate identities, not a claim of registry availability or publication. The existing NuGet publishing workflow and previous .NET preview are unchanged. The .NET SDK is not represented as having the TypeScript SDK's new durable-job helpers. The coordinator requires the three npm versions to match and the .NET version to be a corresponding preview. Version changes must update the existing manifests, lockfiles, package verifier and applicable compatibility documentation deliberately.

## Obtain and verify

In GitHub Actions, choose a reviewed successful `CLI preview candidate` workflow run. Both Linux and Windows install jobs must pass. Download `gpulink-distribution-candidate-<commit>` and extract to a new directory. The CLI-only artifact remains available for existing workflows.

The candidate contains `candidate.json`, `SHA256SUMS`, the existing CLI candidate under `cli/`, two npm SDK archives and one `.nupkg`. Compare `sourceRevision` in `candidate.json` with the trusted run's exact commit. For pull-request runs this may be GitHub's synthetic merge commit; select a reviewed successful `main` run for an accepted main candidate. Do not substitute a candidate with the same version from a different run. From the extracted directory on Linux:

```sh
sha256sum -c SHA256SUMS
```

On Windows PowerShell, verify every record using `Get-FileHash`:

```powershell
Get-Content .\SHA256SUMS | ForEach-Object {
    $parts = $_ -split '  ', 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[a-f0-9]{64}$') { throw 'Invalid checksum record' }
    $actual = (Get-FileHash -LiteralPath $parts[1] -Algorithm SHA256).Hash
    if ($actual -ne $parts[0]) { throw "Checksum mismatch: $($parts[1])" }
}
```

The manifest records the source revision, package identity/version, file sizes, SHA-256 digests, and the two committed npm lockfile digests. These checks detect mismatches against a **trusted** artifact; they are not signatures or independent supply-chain attestation. A contributor with the exact checked-out revision can additionally run `python scripts/release-candidate.py verify <directory> --revision <commit>` to validate package contents and manifest consistency.

## Install only what you need (no Core checkout)

Use absolute paths to the extracted files. In a new, user-owned npm prefix on Linux/WSL:

```sh
npm install --global --prefix "$HOME/.local/share/gpulink-cli" --offline --ignore-scripts --no-audit --no-fund /absolute/candidate/cli/gpulink-cli-0.1.0.tgz
export PATH="$HOME/.local/share/gpulink-cli/bin:$PATH"
gpulink --version
```

See [CLI preview installation](CLI_PREVIEW_RELEASE.md) for Windows and uninstall instructions. In an independent npm application directory with a package.json, install the client package only:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/candidate/gpulink-client-0.1.0.tgz
```

An unrelated application may need its own dependencies already installed or cached for an offline npm install. For an independent workload authoring project, install the Adapter SDK instead, using `gpulink-adapter-sdk-0.1.0.tgz`. The [batch quickstart](DEVELOPER_BATCH_QUICKSTART.md) explains how to create, package and approve a workload and retrieve its result. Installing packages alone starts no service and grants no compute access.

For a new .NET 10 consumer, use the extracted candidate directory as a local NuGet source, with an isolated package cache. For example, in a new disposable project directory on Linux:

```sh
dotnet new console --no-restore
dotnet add package GPULink.Client --version 0.1.0-preview.1 --no-restore
dotnet restore --source /absolute/candidate --packages ./.candidate-packages -p:NuGetAudit=false
```

Use a fresh cache when testing the exact candidate rather than the previously published package with the same version. The installed NuGet bytes are checked in CI. Do not disable audit for normal registry-backed dependency resolution; this example deliberately uses a single local feed containing the no-dependency SDK.

## Candidate engineering gates

The workflow reuses the existing CLI build, the locked TypeScript compiler, `npm pack`, `dotnet pack`, and the existing NuGet content verifier. The new coordinator refuses dirty build checkouts, wrong CLI provenance, unexpected SDK package contents, altered SDK metadata, extra candidate files and existing output directories. The install jobs verify the same combined artifact and exercise the existing CLI acceptance, offline npm SDK installation (including durable wait tests and adapter packaging), and local-feed .NET restoration into a fresh consumer. The existing separate CI contract suites remain required.

The candidate is not a public release, signed attestation, bit-for-bit reproducibility claim, or proof of public registry ownership. Package publishing, signing/attestation, public prerelease numbering, upgrade policies and clean developer validation remain separate decisions. No GPU execution or external deployment is added by this workflow.
