# Model cache inventory

GPUlink workers can report models that are already available on local storage.
This is an inventory mechanism only: it does not download, update, delete, or
execute model content.

## Local manifest

The WSL worker defaults to:

- cache root: `/var/lib/gpulink/models`
- manifest: `/var/lib/gpulink/models/manifest.json`
- refresh interval: 300,000 ms

Copy `deploy/wsl/model-cache-manifest.example.json` to the manifest path and
create each referenced model file or directory beneath the cache root. The
`relativePath` value is local-only and must use a relative POSIX path:

```json
{
  "schemaVersion": 1,
  "models": [{
    "modelId": "nvidia/parakeet-tdt-0.6b-v2",
    "revision": "main",
    "adapterType": "speech.streaming",
    "relativePath": "parakeet-tdt-0.6b-v2"
  }]
}
```

The worker reports only `schemaVersion`, `modelId`, `revision`, and
`adapterType`. It never sends `relativePath` or an absolute filesystem path to
the control plane.

## Validation and failure behavior

- The manifest must be a regular file no larger than 64 KiB.
- It may contain at most 64 unique model IDs.
- Every target must be a regular file or directory inside the real cache root.
- Absolute paths, Windows-style separators, traversal, and symlink escapes are
  rejected.
- A missing manifest means an empty inventory.
- Any invalid or unreadable manifest clears the reported inventory and emits
  only a fixed machine-readable worker log code.

`modelInventory` is not a readiness or residency claim. Adapter health states
whether an implementation can accept work, and `warmModels` identifies models
already loaded by an adapter. Scheduling prefers a warm match first, then a
verified cached match, then GPU utilization and VRAM headroom.

## Configuration

The paths and refresh interval can be changed in the root-readable worker
environment file:

```text
GPULINK_WORKER_MODEL_INVENTORY_INTERVAL_MS=300000
GPULINK_MODEL_CACHE_ROOT=/var/lib/gpulink/models
GPULINK_MODEL_CACHE_MANIFEST=/var/lib/gpulink/models/manifest.json
```

Restart `gpulink-worker.service` after changing its environment. Manifest
content is picked up during the next inventory refresh without a restart.
