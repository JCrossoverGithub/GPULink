# GPULink Self-Hosted Overlay

The self-hosted deployment must provide persistent storage satisfying the GPULink PostgreSQL storage contract.

The portable base requests a StorageClass named:

    gpulink-postgres

That storage implementation must provide:

- at least 20 GiB;
- ReadWriteOnce capability;
- Filesystem volume mode;
- durable storage appropriate for authoritative PostgreSQL data.

The `gpulink-postgres` StorageClass may use either static or dynamic provisioning.

Possible backing implementations include:

- local block storage;
- LVM;
- ZFS;
- Ceph;
- Longhorn;
- SAN or NAS-backed storage;
- another Kubernetes CSI implementation.

Production deployments should use a retention policy appropriate for authoritative database data.

The GPULink core does not require AWS EBS, an AWS CSI driver, or any AWS API.
