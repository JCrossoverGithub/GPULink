# GPULink Manager — DEV-07B1

C+ is the approved visual direction. `design/CPlus.html` is the exact approved offline design source (SHA-256 f19cc5cb937fec7fb954005f09920df693c54124c4e3d746280368eaeaa0f71e). It is NOT served by the live gateway. The first implementation retains the industrial styles, rack/table/topology, resource tree and non-modal inspector. The shipped live view has no simulated operation or fallback records. This is a development preview, not the eventual production package.

## Run with an existing local Core installation

On Linux/WSL with Node 24, start the selected Core installation by its existing managed CLI workflow, then run:

```
node manager/gateway.mjs --config-dir /absolute/path/to/installation
```

Open the exact printed `http://127.0.0.1:PORT/` address. Ctrl+C closes the manager only. The preview accepts the generated private `admin.env` and `client.env` profiles for `http://127.0.0.1:8088`, read under the current user's ownership and POSIX permissions. The Core listener must be trusted and already running; the manager neither starts it nor verifies its process identity. No credentials are passed to the browser. No LAN bind, reverse proxy, external assets, arbitrary upstream URL, raw upstream error, or write route. This is a local operator trust boundary, not multi-user authentication: other trusted local processes can access the manager. Do not expose it to a network. Metadata displayed from Core is operational data and may itself be sensitive.

## Disposable UI acceptance

```
node --test test/manager-readonly.test.mjs
node manager/qa/preview-fixture.mjs
```

The fixture starts the actual HTTP server and in-memory SQLite persistence on ephemeral loopback ports with synthetic worker telemetry, one cancelled job/hold, and one session. It is labeled in the UI. No GPU is used and no real installation is accessed. Ctrl+C closes both fixture services. This is not physical GPU acceptance. `manager/qa/browser_check.py` is optional Python Playwright QA, using Chromium installed separately. It defaults to direct browser HTTP; `--offline-render` uses a real retrieved response, with fetch replaced solely in the test browser. The latter was used in the sandbox because Chromium policy prevented direct navigation. The HTTP integration test independently exercises the actual gateway. No Python runtime is required for Manager.

## Data contract and limitations

- Fixed GETs to readyz, workers, jobs, sessions, known job cleanup holds. 500 records per list, status-specific queries for active and queued/requested states, bounded recent history. At-limit lists and conflicting duplicate records are flagged. No pagination or atomic snapshot contract is claimed. Counts are observed, not whole-cluster totals. Non-atomic reads can still miss changes, even without a conflict flag.
- GPU identity includes worker and UUID; cleanup holds match UUID globally to cover re-enrollment. Reported devices are not guaranteed distinct physical hardware. Unallocated is not asserted. Other fence types, scheduler eligibility, reasons and historical metrics are not exposed. Online is Core's reported status, not independent freshness validation. Last heartbeat is shown; stale/offline telemetry is hidden. Power null remains unknown.
- Explicit field projection omits payloads, results, error details, session metadata, raw event data, lease identifiers, worker labels and URLs. No token is intentionally exposed. This is not a general content-redaction system for values supplied as names/project IDs.
- All upstream reads have four-second deadlines, bounded bodies, redirect refusal. Concurrent snapshots coalesce and reuse a successful sample for one second; errors return a fixed 503. Browser retains last successful snapshot with stale marking on failure. Gateway only listens on exact IPv4 loopback and verifies Host/Origin/fetch-site, rejects all non-GET requests, serves fixed assets, has no CORS, uses CSP and no-store. No process lifecycle authority or recovery controls.
- Browser search, navigation and inspector are implemented; full filters, richer details, event timeline, scale/performance, accessibility, Firefox, production build/toolchain and CLI distribution are subsequent work. Existing dashboard/Core untouched. A separate frontend framework decision is deferred until the implementation and packaging needs are established, not based on the previous project's Angular choice.

## Validation status

Sandbox: four Node tests passed against reconstructed Core on Linux Node 22 (real HTTP/SQLite, scope and projection, redirects/malformed response, profile checks, capped list behavior). Chromium offline render using actual gateway response: navigation, inspector, rack/topology/tree, 1440/1024/768/390px, injected disconnect and stale retention, no JS errors. Direct browser-to-gateway acceptance is outstanding due to sandbox browser restrictions. The integration kit checks the accepted main revision and hashes of the inspected Core contract files before adding the manager; Node 24 tests on the actual checkout are required.
