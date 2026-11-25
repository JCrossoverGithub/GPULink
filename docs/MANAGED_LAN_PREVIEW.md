# GPULink managed private LAN preview — DEV-03B

The November 25 DEV-03 physical exercise (PR #32) validated the manually
configured, independently installed server and GPU worker, including an
actual NVIDIA diagnostic, drain, offline detection and same-identity rejoin.
The automation here is a separate deployment adapter, not a change to Core.

## Supported first path

- Server: non-root Ubuntu 24.04 WSL2 NAT, Windows interop at `/mnt/c`,
  Node 24+, OpenSSL, iproute2; Windows PowerShell and administrative approval.
- Worker: Linux / WSL2, installed Node 24+ CLI, supported NVIDIA driver.
- One trusted private IPv4 peer on the same LAN, one loopback backend on
  port 8088. No public internet, router changes, global certificate trust,
  domain-joined networks, native Windows services or mirrored WSL networking.
- Caddy from PATH, an explicitly specified trusted executable, or a download
  from configured Ubuntu apt repositories (`apt download`, `dpkg-deb -x`).
  Fetch requires network and current apt indexes; no system package install
  or system service configuration. The CLI itself remains offline-installable.

## Server

Install the candidate outside the source checkout. Use a fresh short Linux
configuration path (never reuse an existing installation for this preview).
Get the intended worker's Windows LAN IPv4 address from its operator; do not
allow an entire subnet. For example:

```sh
gpulink --config-dir "$HOME/.gpulink/lan-s" setup server --peer 192.168.1.20
```

This read-only plan detects WSL NAT, a unique Windows interface on the peer's
subnet, its profile and WSL IP. It chooses an available HTTPS port from
8443–8499 or validates an explicit `--port`. It creates nothing. Review the
plan. Add `--apply` to create a fresh private profile, generate a private CA
and IP SAN server certificate, acquire/validate Caddy, start the owned
loopback backend and verify local HTTPS with explicit CA/hostname checking.
The plan is re-evaluated at apply time and rechecked before elevation.

```sh
gpulink --config-dir "$HOME/.gpulink/lan-s" setup server --peer 192.168.1.20 --apply
```

Approve the Windows UAC prompt. Only a fixed generated PowerShell program
with validated IP/port/interface inputs runs elevated. It refuses existing
forwarding entries/listeners, creates a uniquely named peer-scoped firewall
rule for the detected interface/profile, and adds the exact portproxy entry. Existing Windows policy may already allow other traffic; this does not rewrite or audit every unrelated firewall rule.
The private `managed-lan/network.json` journal records the desired resource
identity before elevation. Local readiness does not prove remote reachability.
Keep the setup terminal open: this is a foreground session, not a service
installed at boot. Caddy supports HTTP(S)/WebSocket proxying; no new streaming
acceptance claim is made by this onboarding candidate.

In another server terminal, create an encrypted invitation file:

```sh
gpulink --config-dir "$HOME/.gpulink/lan-s" setup invite --output /path/to/worker-invite.json
```

The CLI displays a random 256-bit invitation code once. **Do not paste the
code or file into public logs/chat.** Transfer the encrypted file and code
through separate trusted channels; establish the intended operator's identity.
AES-256-GCM authenticates the encrypted worker-only bundle and public CA.
The envelope expires locally after 30 minutes. It is not server-side token
expiry, a one-time invitation, an individually revocable credential, or a
replacement for trusted peer provisioning. The underlying worker credential
remains deployment-wide and reusable. A recipient who decrypts it has that
worker authority; rotation requires separate deployment administration.

## Worker

```sh
gpulink --config-dir "$HOME/.gpulink/lan-w" join --invite /path/to/worker-invite.json
```

Enter the code at the hidden interactive prompt. The command imports the
bundle and CA into a fresh private installation and runs the existing live
worker doctor (TLS, auth and physical GPU discovery). It does not start work
unless `--accept-assigned-work` is explicitly supplied. If doctor fails, the
created worker installation remains available for diagnosis; do not overwrite.
When ready, use the existing `worker start --accept-assigned-work` command.
Use the existing server `workers`, `jobs`, `submit-diagnostic`, `drain` and
worker status/stop commands. Delete transferred encrypted files when done.

## Stop and recover

Drain the worker on the server, confirm jobs terminal, stop the worker, and
then press Ctrl+C in the setup terminal. The command stops its own Caddy child,
requests administrator approval to remove the exact forwarding and firewall
resources, and stops the verified owned backend. It retains private
configuration, certificates and SQLite. No global trust changes to undo.
If network identity changes during the session, a periodic read-only check
closes the managed ingress and initiates cleanup instead of silently widening
or redirecting access. This is detection, not in-place address repair.

If UAC was denied, the process was interrupted, or cleanup failed, inspect the
Windows state and run the following from the original Linux installation:

```sh
gpulink --config-dir "$HOME/.gpulink/lan-s" setup cleanup
```

This recovery command only removes Windows resources matching the journal
and unique ownership rule. It refuses mismatches or orphan forwarding without
the rule; it does not kill Caddy or the backend. Use existing server status/stop
for the owned backend and inspect any remaining proxy separately. A denied or
timed-out UAC operation is not proof that no changes were made. Retain the
journal until cleanup is verified; do not delete it prematurely. Abrupt process
or host termination is not guaranteed to clean up forwarding. Do not run
cleanup concurrently with active setup. Fresh setup is non-overwriting; reuse
of an existing managed profile, renewal and in-place DHCP repair are follow-up
work. Existing operator-managed Linux deployments remain supported unchanged.

## Acceptance

- Source tests: port choice, subnet checks, restricted generated networking
  plan, Windows PowerShell parser (Windows CI, no privilege), Caddy config,
  generated CA and actual HTTPS identity verification, authenticated encryption,
  incorrect code/tampering/expiry rejection.
- Installed CLI regression: entry points present, incomplete setup refused;
  existing packaged local and server/worker auth tests remain.
- Physical acceptance required: same reviewed package on two physical machines;
  no hand-written firewall, TLS or proxy commands, only UAC and intended peer
  input; encrypted invitation and interactive code; worker doctor, registration,
  diagnostic, drain/stop; verify automatic cleanup leaves unrelated rules and
  installations untouched. No physical acceptance is claimed by source tests.
