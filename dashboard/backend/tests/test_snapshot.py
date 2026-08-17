from __future__ import annotations

import unittest

from gpulink_dashboard.snapshot import build_snapshot


class SnapshotClient:
    def health(self):
        return {"status": "ok"}

    def workers(self):
        return {
            "workers": [
                {
                    "id": "worker-online",
                    "status": "online",
                    "drainMode": False,
                    "internalField": "not for the browser",
                    "gpus": [{"memoryTotalMiB": 8192, "memoryUsedMiB": 2048}],
                },
                {
                    "id": "worker-drained",
                    "status": "online",
                    "drainMode": True,
                    "gpus": [{"memoryTotalMiB": 8192, "memoryUsedMiB": 1024}],
                },
            ],
        }

    def jobs(self, *, limit):
        self.limit = limit
        return {
            "jobs": [
                {"id": "older", "status": "succeeded", "createdAt": 10},
                {
                    "id": "newer",
                    "status": "queued",
                    "createdAt": 20,
                    "payload": {"audio": "not for the browser"},
                    "result": {"private": True},
                    "error": {"details": "private"},
                },
            ],
        }


class SnapshotTests(unittest.TestCase):
    def test_builds_bounded_safe_projection(self):
        client = SnapshotClient()
        snapshot = build_snapshot(client)

        self.assertEqual(client.limit, 100)
        self.assertEqual(snapshot["summary"]["workersTotal"], 2)
        self.assertEqual(snapshot["summary"]["workersOnline"], 2)
        self.assertEqual(snapshot["summary"]["workersDrained"], 1)
        self.assertEqual(snapshot["summary"]["gpusTotal"], 2)
        self.assertEqual(snapshot["summary"]["memoryTotalMiB"], 16_384)
        self.assertEqual(snapshot["summary"]["memoryUsedMiB"], 3_072)
        self.assertEqual(snapshot["jobsByStatus"], {"queued": 1, "succeeded": 1})
        self.assertEqual([job["id"] for job in snapshot["jobs"]], ["newer", "older"])
        self.assertNotIn("payload", snapshot["jobs"][0])
        self.assertNotIn("result", snapshot["jobs"][0])
        self.assertNotIn("error", snapshot["jobs"][0])
        self.assertNotIn("internalField", snapshot["workers"][0])


if __name__ == "__main__":
    unittest.main()
