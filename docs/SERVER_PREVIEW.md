# GPULink server preview (DEV-02)

One trusted operator, one Linux control plane/relay, SQLite, Node.js 24+.
Use the reviewed installable CLI candidate, not a Core checkout. No GPU,
CUDA, WSL or container runtime is needed on the control-plane host. The
initial managed lifecycle uses the existing Linux supervisor, not a systemd
service. It does not restart automatically after a reboot or supervisor crash.

## Initialize and start

Choose a DNS name you control, pointing to this server (or reachable through
your private network). Obtain TLS through your existing reverse proxy, with
a certificate trusted by clients/workers. This preview does not provision
DNS, certificates, firewall rules or public ingress automatically.

```sh
gpulink init server --public-url https://gpu.example.org
gpulink doctor server
gpulink server start
gpulink server status
```

The default server profile is `~/.gpulink/instances/server`, distinct from
`~/.gpulink/instances/local`. To select a different installation, prefix
**every** command with `--config-dir /absolute/private/path`. Initialization
creates a new private directory, four distinct deployment secrets and a
non-secret `server.json`. Existing files are never overwritten. The backend
binds only to `127.0.0.1:8088`; one running GPULink instance per host is
supported by this fixed-port preview. Never expose port 8088 directly.
Use a short private path to fit the existing Unix socket path limit.
The generated worker profile is reserved for the inherited loopback profile
contract; do not copy it to another machine or start a local worker using
a server installation. Use the separate [remote worker preview](REMOTE_WORKER_PREVIEW.md) for worker bundle export and enrollment.

## HTTPS ingress (operator-managed)

Example Caddy site block (replace the hostname, review and incorporate into
your existing proxy configuration; do not replace an unrelated site):

```caddyfile
gpu.example.org {
    reverse_proxy 127.0.0.1:8088
}
```

The proxy must run on the same host/network namespace as the backend.
Use a valid certificate, HTTPS on the configured origin, and preserve API
paths and WebSocket upgrades. Caddy can manage TLS for a suitable domain;
for a private CA, provision its public CA certificate to authorized clients
and configure runtime trust (Node can use `NODE_EXTRA_CA_CERTS`). Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`. Restrict ingress to trusted parties using
your firewall/VPN as appropriate; the current deployment-wide role tokens
are not a multi-tenant authorization boundary. Do not enable request-header
logging that records Authorization. Proxy installation, DNS/firewall and
certificate provisioning are operator responsibilities. No proxy process is
started or stopped by GPULink.

After configuring the proxy:

```sh
gpulink doctor server --live
```

Offline doctor checks the local profile; live doctor additionally makes a
bounded, credential-free HTTPS `/readyz` request, verifies certificate and
hostname, and refuses redirects. It reports readiness, not authenticated
identity of a particular deployment or remote network reachability from a
second host. Test from that host in DEV-03. If local readiness is good but
live doctor fails, check DNS, routing, proxy and CA trust. Never disable TLS.

For local operator API inspection, select the server profile explicitly:

```sh
gpulink --config-dir "$HOME/.gpulink/instances/server" jobs
```

For an authorized external client, configure `GPULINK_URL` to the HTTPS
origin and provide only the client-role token using a private out-of-band
secret transfer; never transfer `control-plane.env` or admin/signing keys.
Use a separate client environment without an automatically selected local
profile. The client token is deployment-wide, not project-specific.

## Stop and remove

```sh
gpulink server stop
gpulink server status
```

Only stop during planned downtime after remote applications/workloads are
stopped. This does not coordinate remote-worker drain or prove physical GPU
cleanup; those are not DEV-02 features. The supervisor never adopts another
process or stops the proxy. Unknown ownership, stale records and an occupied
backend port require investigation; never signal a PID from a record.
Uninstalling the CLI preserves private instance configuration and SQLite
state. Disable your proxy route separately if retiring the deployment.

## Acceptance boundary

The packaged Linux acceptance starts an actual installed backend, creates a
disposable test-only certificate and loopback HTTPS proxy, verifies trusted
TLS, untrusted-certificate rejection even with an insecure global Node
setting, authenticated empty jobs and invalid-token rejection, then stops
its own processes. It is not a public certificate, real external-host or
WebSocket acceptance. Windows installation still works, but managed server
initialization is refused. No worker, GPU job or cloud operation is involved.
