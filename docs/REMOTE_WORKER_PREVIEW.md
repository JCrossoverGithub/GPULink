# GPULink remote GPU worker preview (DEV-03)

This is the installed operator path for a trusted private deployment, not a
public GPU marketplace. Use the same reviewed CLI artifact on a Linux server
and a separate Linux NVIDIA GPU host (WSL is optional). Node.js 24+, npm,
a working `nvidia-smi`, and a reachable operator-owned HTTPS endpoint are
required. The control plane remains loopback-only behind its TLS proxy.
See [SERVER_PREVIEW.md](SERVER_PREVIEW.md) for the server setup and ingress.
No public certificate, GPU driver, runtime or cloud provisioning is automatic.

## 1. Export only the worker credential (server)

Use the existing initialized server and a private transfer directory:

```sh
mkdir -m 700 "$HOME/gpulink-transfer"
gpulink server worker-bundle --output "$HOME/gpulink-transfer/worker.json"
```

If using a nondefault server profile, prefix the command with its explicit
`--config-dir`. The export is exclusive/non-overwriting and creates a 0600
file containing the configured public HTTPS origin and **only the shared
worker-role credential**. It does not contact the server or create a worker.
The bundle is a reusable secret, not a one-time invite or independently
revocable token. Anyone holding it has the deployment's worker authority;
transfer it only to trusted operators via SSH/SCP or another authenticated,
confidential channel. Never paste it in chat, print it, commit it, or transfer
`control-plane.env`, client/admin tokens, or the signing key. Delete temporary
bundle copies after successful enrollment; deleting copies does not revoke
the credential.

## 2. Enroll the separate physical GPU host

Transfer the bundle to an owner-only directory on the worker and restrict
its permissions to 0600. For a private CA, transfer its **public certificate**
separately using an authenticated channel and independently establish that
it is the intended trust anchor. Never transfer the CA private key. The
worker commands default to `~/.gpulink/instances/worker` (distinct from local
and server profiles); prefix every command with `--config-dir` to select a
nondefault installation. Keep the path short for the supervisor Unix socket.

```sh
gpulink worker enroll --bundle "$HOME/gpulink-transfer/worker.json"
# OR, for an operator-verified private CA:
# gpulink worker enroll --bundle "$HOME/gpulink-transfer/worker.json" --ca-file /path/to/public-ca.pem

gpulink worker doctor --live --gpu
gpulink worker status
```

Enrollment creates a private directory, stable random worker name and a
separate local ownership key. It does not overwrite a profile, register a
worker, start a service or allocate GPU work. Do not clone an enrolled
configuration onto another machine. The worker profile has no client/admin
or control-plane signing credentials. Do not create two GPULink workers
advertising the same physical GPU, including workers outside this CLI.

`worker doctor` validates configuration and Node version offline. `--live`
checks certificate/hostname trust and worker-role authentication against the
existing read-only leases API for a nonexistent worker; it never registers
or requests an allocation. `--gpu` queries physical NVIDIA inventory using
`nvidia-smi`; no job is submitted. Live diagnostics use Node's bundled root
certificates plus the explicitly imported public CA, if any. Managed worker
processes receive the copied CA via `NODE_EXTRA_CA_CERTS` and a clean child
environment. Do not disable TLS verification or rely on an inherited
`NODE_EXTRA_CA_CERTS` environment value. The operator must configure DNS,
firewall and proxy routing. These checks do not prove network reliability
or long-lived WebSocket behavior.

## 3. Start and inspect

Use an otherwise idle, dedicated GPU host and a disposable deployment for
first acceptance. Ensure no other worker process advertises its GPU and no
unexpected work is queued. Starting the worker **can immediately execute
approved queued work**; explicit authorization is mandatory.

```sh
gpulink worker start --accept-assigned-work
gpulink worker status
```

The installed CLI reuses the Linux managed supervisor, verifies a worker
registration event with positive GPU inventory, and reports locally verified
process state. A ready supervisor does not guarantee a current heartbeat or
available scheduling capacity. Check the operator's server inventory:

```sh
gpulink --config-dir "$HOME/.gpulink/instances/server" workers
```

Find the generated worker name and confirm its `id`, `status`, `gpus`, and
capabilities. The first supported managed remote profile advertises only
`diagnostic.echo` and `diagnostic.gpu-status`, not arbitrary programs or
adapter catalogs. Subsequent workload support will extend the product
separately. No synthetic GPU inventory is used by this managed profile.

## 4. Planned idle stop/rejoin

Drain from the server using the ID reported by `workers`:

```sh
gpulink --config-dir "$HOME/.gpulink/instances/server" drain WORKER_ID
```

Wait until assigned jobs and sessions have finished and leases are cleared;
use a disposable deployment with no active jobs or sessions for this first
exercise. Drain is admission control, not forced cancellation. Stop the
worker using the worker host CLI:

```sh
gpulink worker stop
gpulink worker status
```

Only the verified local supervisor can stop its own child. No PID from a
file is signaled. Server records remain, and the existing heartbeat expiry
marks the worker offline asynchronously. Verify that outcome on the server
before restarting. Rejoin using the same installed profile and explicit
`--accept-assigned-work`; the same worker name should upsert the existing
server ID. Drain state persists; only resume after checking inventory and
that there are no stale allocations:

```sh
gpulink --config-dir "$HOME/.gpulink/instances/server" resume WORKER_ID
```

Finish by draining and stopping the worker before stopping the dedicated
server. Keep configuration and CA files intact until verified shutdown;
unknown ownership or stop timeout requires investigation, not deletion of
records or force killing an unverified PID. No automatic reboot restart,
per-worker credential rotation/revocation, hard-stop fencing, guaranteed
active-work recovery, or removal of server inventory records is claimed.

## Acceptance evidence

The installed artifact acceptance on Linux exports a worker-only bundle,
creates separate worker profiles, validates actual HTTPS/worker-role auth
against a running disposable installed server, rejects untrusted TLS and an
incorrect credential, and verifies no worker registered. No unattended CI
starts a GPU worker. Real cross-host acceptance is explicit: a physical
NVIDIA GPU, server-side inventory, planned idle stop/offline and same-ID
rejoin, followed by a safe teardown. Record the reviewed artifact SHA,
host roles (not secrets or private hostnames), GPU model, and observations.
Do not label the hardware exercise accepted before it actually runs.

For the optional WSL2 NAT private LAN automation candidate (DEV-03B), see
[managed LAN setup](MANAGED_LAN_PREVIEW.md). The manual operator-managed
server and worker commands above remain available independently.

## Trusted workload extension (DEV-04A candidate)

The installed remote-worker CLI can explicitly approve an existing pinned
subprocess catalog while stopped. See [installed workload preview](INSTALLED_WORKLOAD_PREVIEW.md)
for trust boundaries, commands and pending acceptance.
