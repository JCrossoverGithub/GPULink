# GPULink Kubernetes Runtime Versions

## K3s

Production baseline:

    v1.36.4+k3s1

The K3s version is explicitly pinned for reproducibility.

The newest upstream release should not automatically become the GPULink production version. Upgrades must be deliberate, reviewed, and tested.

## Upgrade Policy

K3s upgrades must:

1. be performed explicitly;
2. be tested before production rollout;
3. preserve the GPULink cloud-portability architecture;
4. verify PostgreSQL persistent storage before and after the upgrade;
5. verify the GPULink control plane and worker connectivity after the upgrade.

The installation script refuses to perform an implicit K3s upgrade or downgrade if a different version is already installed.
