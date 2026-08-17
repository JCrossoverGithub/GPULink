from __future__ import annotations

import unittest

from gpulink_dashboard import create_app
from gpulink_dashboard.client import GpuLinkApiError
from gpulink_dashboard.config import Settings


SETTINGS = Settings(
    control_plane_url="https://gpu.example.test",
    admin_token="a" * 64,
    client_token="c" * 64,
)


class FakeClient:
    def health(self):
        return {"status": "ok"}

    def workers(self):
        return {
            "workers": [{
                "id": "worker-1",
                "name": "desktop-3070ti",
                "status": "online",
                "drainMode": False,
                "labels": {"hostType": "desktop"},
                "gpus": [{
                    "uuid": "gpu-1",
                    "name": "NVIDIA GeForce RTX 3070 Ti",
                    "memoryTotalMiB": 8192,
                    "memoryUsedMiB": 2048,
                    "utilizationPercent": 25,
                    "temperatureC": 48,
                    "powerDrawWatts": 72.5,
                }],
            }],
        }

    def jobs(self, *, limit):
        self.requested_limit = limit
        return {
            "jobs": [{
                "id": "job-1",
                "projectId": "gpulink-operations",
                "type": "diagnostic.gpu-status",
                "status": "succeeded",
                "payload": {"must": "not leak"},
                "result": {"must": "not leak"},
                "createdAt": 100,
                "updatedAt": 200,
            }],
        }


class FailingClient(FakeClient):
    def workers(self):
        raise GpuLinkApiError("control plane unavailable")


class DashboardAppTests(unittest.TestCase):
    def test_snapshot_aggregates_fleet_without_exposing_job_payloads(self):
        fake_client = FakeClient()
        app = create_app(settings=SETTINGS, client=fake_client)

        with app.test_client() as client:
            response = client.get("/api/dashboard/snapshot")

        self.assertEqual(response.status_code, 200)
        content = response.get_json()
        self.assertEqual(content["summary"]["workersOnline"], 1)
        self.assertEqual(content["summary"]["gpusTotal"], 1)
        self.assertEqual(content["summary"]["memoryUsedMiB"], 2048)
        self.assertEqual(content["jobsByStatus"], {"succeeded": 1})
        self.assertNotIn("payload", content["jobs"][0])
        self.assertNotIn("result", content["jobs"][0])
        self.assertEqual(fake_client.requested_limit, 100)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")

    def test_upstream_failure_is_sanitized(self):
        app = create_app(settings=SETTINGS, client=FailingClient())

        with app.test_client() as client:
            response = client.get("/api/dashboard/snapshot")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json(), {
            "error": {
                "code": "upstream_error",
                "message": "control plane unavailable",
            },
        })

    def test_gateway_health_does_not_contact_upstream(self):
        app = create_app(settings=SETTINGS, client=FailingClient())

        with app.test_client() as client:
            response = client.get("/api/dashboard/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
