# First Operational Target

## Goal

Prove that an external authorized device can submit a safe GPU diagnostic to a
DigitalOcean-hosted GPUlink control plane, have it scheduled onto either the
desktop RTX 3070 Ti or laptop RTX 4060 worker through outbound-only HTTPS, and
receive a verified result. Then prove drain, worker restart, and control-plane
restart behavior.

This target does not install Parakeet or a local LLM.

## Prerequisites

- A private GitHub repository containing this tree
- A domain or subdomain pointed at the droplet
- Ubuntu on the DigitalOcean droplet
- Docker Engine and Docker Compose v2 on the droplet
- Nginx and Certbot on the droplet
- WSL2 Ubuntu with systemd on both Windows machines
- Node.js 24 or newer at `/usr/bin/node` inside each WSL distribution
- `nvidia-smi` working inside WSL

Never paste tokens into GitHub, an issue, a commit, or chat. Keep the three
control-plane credentials different.

## 1. Install the control plane

On the droplet, clone the private repository and enter it:

```bash
git clone <your-private-gpulink-repository-url>
cd gpulink
```

Verify the container tooling and source before installing:

```bash
docker version
docker compose version
git status --short
```

Install the isolated Docker service:

```bash
sudo ./scripts/install-control-plane-docker.sh
```

The installer copies the reviewed source under `/opt/gpulink`, generates three
credentials if none exist, creates a named Docker volume for durable state, and
publishes the API only on `127.0.0.1:8088`. The container uses the pinned
official Node.js 24 image, a read-only root filesystem, no Linux capabilities,
and explicit CPU and memory limits.

Confirm local health:

```bash
curl --fail http://127.0.0.1:8088/healthz
sudo docker compose \
  -f /opt/gpulink/deploy/digitalocean/compose.yml ps
sudo docker compose \
  -f /opt/gpulink/deploy/digitalocean/compose.yml logs --tail=100
```

Retrieve credentials only from a secure administrative session:

```bash
sudo grep '^GPULINK_' /etc/gpulink/control-plane.env
```

Store them in a password manager. The client token goes only to authorized
client devices, the worker token goes only to workers, and the admin token stays
with the operator.

## 2. Configure HTTPS

Copy the Nginx example and replace the example hostname when necessary:

```bash
sudo install -o root -g root -m 0644 \
  deploy/digitalocean/nginx-gpulink.conf.example \
  /etc/nginx/sites-available/gpulink
sudo editor /etc/nginx/sites-available/gpulink
sudo ln -s /etc/nginx/sites-available/gpulink /etc/nginx/sites-enabled/gpulink
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d gpulink.schultzsystems.com
```

Only SSH, HTTP, and HTTPS should be publicly permitted. Port `8088` must remain
closed externally.

Verify from a device outside the droplet:

```bash
curl --fail https://gpulink.schultzsystems.com/healthz
```

Do not enroll workers until HTTPS succeeds with a valid certificate.

## 3. Prepare WSL systemd

Inside each WSL distribution, `/etc/wsl.conf` must contain:

```ini
[boot]
systemd=true
```

After editing it, run this from Windows PowerShell:

```powershell
wsl --shutdown
```

Restart WSL and verify:

```bash
systemctl is-system-running
nvidia-smi
node --version
```

## 4. Enroll the desktop worker

Clone the same private repository inside the desktop's WSL distribution. Read
the worker token without placing it directly in shell history:

```bash
cd gpulink
read -rsp "GPUlink worker token: " GPULINK_WORKER_TOKEN
echo
export GPULINK_WORKER_TOKEN
export GPULINK_URL=https://gpulink.schultzsystems.com
export GPULINK_WORKER_HOST_TYPE=desktop
sudo -E ./scripts/install-worker-wsl.sh desktop-3070ti
unset GPULINK_WORKER_TOKEN
```

Verify:

```bash
sudo systemctl status gpulink-worker --no-pager
sudo journalctl -u gpulink-worker -n 100 --no-pager
```

Install the Windows sign-in task from an elevated PowerShell session. If the
repository exists only inside WSL, open the script through a path such as
`\\wsl.localhost\Ubuntu-24.04\home\<WSL-user>\gpulink\deploy\windows` first.
Then run:

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\deploy\windows\install-startup-task.ps1 `
  -DistroName Ubuntu-24.04
```

Use the exact distribution name shown by `wsl --list --verbose`.

## 5. Enroll the laptop worker

Repeat the process on the laptop with:

```bash
export GPULINK_WORKER_HOST_TYPE=laptop
sudo -E ./scripts/install-worker-wsl.sh laptop-4060
```

The current sign-in task uses Windows Task Scheduler's battery-safe defaults.
Native gaming and battery-mode automation will be added after this first
connection and scheduling target is accepted.

## 6. Verify both workers

From an administrative copy of the repository:

```bash
export GPULINK_URL=https://gpulink.schultzsystems.com
read -rsp "GPUlink admin token: " GPULINK_ADMIN_TOKEN
echo
export GPULINK_ADMIN_TOKEN
npm run cli -- workers
```

Both workers must report `online` with their real GPU names, UUIDs, total VRAM,
used VRAM, utilization, temperature, and power where supported.

## 7. Submit a real GPU diagnostic

```bash
read -rsp "GPUlink client token: " GPULINK_CLIENT_TOKEN
echo
export GPULINK_CLIENT_TOKEN
npm run cli -- submit-diagnostic 256
```

Copy the returned job ID:

```bash
npm run cli -- wait <job-id>
```

The result must contain the same GPU UUID that the scheduler assigned. It must
also report the driver version, total and used VRAM, utilization, temperature,
power when available, and current clocks.

## 8. Acceptance checks

### Drain and alternate placement

1. List workers and copy the desktop worker ID.
2. Run `npm run cli -- drain <desktop-worker-id>`.
3. Submit another diagnostic.
4. Confirm it is assigned to the laptop.
5. Run `npm run cli -- resume <desktop-worker-id>`.

### Worker restart

On one worker:

```bash
sudo systemctl restart gpulink-worker
```

Confirm it returns online without creating a duplicate worker identity.

### Control-plane restart

Submit a job while both workers are drained, then restart the control plane:

```bash
sudo docker compose \
  -f /opt/gpulink/deploy/digitalocean/compose.yml restart control-plane
```

Confirm the queued job still exists. Resume one worker and confirm the job is
assigned and completed.

### External access

From a device outside the home network, submit a diagnostic using the client
token. Confirm that neither Windows machine has an inbound port forwarded and
that the job still completes.

## Exit criteria

The first operational target is complete only when:

- the public endpoint uses valid HTTPS;
- client, worker, and admin credentials are scope-separated;
- both real WSL workers remain outbound-only;
- both GPUs are discovered correctly;
- a diagnostic can run on either GPU;
- draining controls placement;
- workers reconnect after service restart;
- durable jobs survive a control-plane restart;
- no secret appears in Git or logs.
