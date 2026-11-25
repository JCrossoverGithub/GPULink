# Installed remote worker acceptance — November 25, 2026

PR #32 merged at `99cbcb3c33a0c61a49f7ed38bd67d3d5995261fc`.
The final corrected implementation commit was
`375abc7c244f75bc8c796a348db0f3f8a83a1e48`; CI and CLI preview candidate
workflows completed successfully, eight checks passed. Operator-recorded
acceptance: https://github.com/JCrossoverGithub/GPULink/pull/32#issuecomment-7175260753.

Two independently installed physical Windows hosts running Linux/WSL2 used
the same private LAN with operator-managed HTTPS ingress. The server used
the original DEV-03 candidate; the worker used the protocol-compatible
corrected candidate. The enrolled NVIDIA RTX 3090 Ti reported 24564 MiB.
Fractional temperature readings initially failed inventory validation; the
fix rounds inventory temperatures to the existing integer protocol contract.
A `diagnostic.gpu-status` job with a 4096 MiB minimum succeeded on its first
attempt, with returned physical telemetry and no job error. Drain succeeded;
the owned worker stopped and the server observed it offline. Restart
preserved worker identity, drain state and a single worker record. The
control plane stopped gracefully and retained SQLite. Temporary Windows
firewall/port-forward rules and transfer copies were removed. Final worker
stop found no ownership record; status was not-running and the operator
reported no process in the installation directory. The operator reported
cleanup complete before merging.

Scope: physical telemetry diagnostic, not arbitrary CUDA computation;
trusted deployment-wide worker credentials, not individually revocable
identity. Manual provisioning of TLS, IP correction, Windows UAC, firewall,
WSL forwarding and encrypted credential transfer exposed onboarding friction.
DEV-03B addresses that path separately; independent newcomer acceptance,
production isolation, unattended recovery and package publication are not
established by this test.
