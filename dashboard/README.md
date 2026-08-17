# GPUlink Operations Console

This directory contains the first visual operations surface for GPUlink:

- `backend/` is a small Flask backend-for-frontend;
- `frontend/` is a standalone Angular operations console.

The Node.js control plane remains authoritative for worker identity, durable
job state, leases, and scheduling. Flask makes bounded read-only calls to that
API, aggregates an operations snapshot, and removes job payloads and results
before the response reaches the browser.

## Security boundary

The Angular application never receives `GPULINK_ADMIN_TOKEN` or
`GPULINK_CLIENT_TOKEN`. Those credentials exist only in the Flask process.
This first slice binds Flask and the Angular development server to loopback and
is intended for local operation. Do not expose either development server to the
internet. Authenticated production routing is a separate deployment change.

The Flask gateway does not enable CORS. Angular reaches it through the local
development proxy, keeping browser requests on one origin.

## Requirements

- Python 3.12 or newer
- Node.js 24.15 or newer
- A reachable GPUlink control plane
- Valid GPUlink administrator and client credentials

## Start the Flask gateway

From `dashboard/backend`:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

export GPULINK_URL=https://gpulink.schultzsystems.com
export GPULINK_ADMIN_TOKEN=replace-me
export GPULINK_CLIENT_TOKEN=replace-me

python run.py
```

The gateway listens on `127.0.0.1:5050` by default. Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GPULINK_DASHBOARD_BIND_HOST` | `127.0.0.1` | Flask listener address |
| `GPULINK_DASHBOARD_BIND_PORT` | `5050` | Flask listener port |
| `GPULINK_DASHBOARD_TIMEOUT_SECONDS` | `10` | Upstream request timeout |

Do not put real tokens in a repository file or frontend environment file.

## Start the Angular console

In a second terminal, from `dashboard/frontend`:

```bash
npm install
npm start
```

Open `http://127.0.0.1:4200`. The development proxy forwards only `/api`
requests to the loopback Flask gateway. The console refreshes every five
seconds and retains the last valid snapshot during a temporary gateway error.

## Verification

Backend:

```bash
cd dashboard/backend
PYTHONPATH=. python -m unittest discover -s tests
```

Frontend:

```bash
cd dashboard/frontend
npm run build
```
