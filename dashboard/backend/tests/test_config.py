from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from gpulink_dashboard.config import ConfigurationError, Settings


BASE_ENVIRONMENT = {
    "GPULINK_URL": "https://gpu.example.test/",
    "GPULINK_ADMIN_TOKEN": "a" * 64,
    "GPULINK_CLIENT_TOKEN": "c" * 64,
}


class SettingsTests(unittest.TestCase):
    def test_loads_and_normalizes_environment(self):
        environment = {
            **BASE_ENVIRONMENT,
            "GPULINK_DASHBOARD_BIND_PORT": "6060",
            "GPULINK_DASHBOARD_TIMEOUT_SECONDS": "2.5",
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = Settings.from_environment()

        self.assertEqual(settings.control_plane_url, "https://gpu.example.test")
        self.assertEqual(settings.bind_host, "127.0.0.1")
        self.assertEqual(settings.bind_port, 6060)
        self.assertEqual(settings.request_timeout_seconds, 2.5)

    def test_rejects_short_bootstrap_credentials(self):
        environment = {**BASE_ENVIRONMENT, "GPULINK_ADMIN_TOKEN": "too-short"}
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ConfigurationError, "at least 32"):
                Settings.from_environment()

    def test_rejects_invalid_listener_port(self):
        environment = {**BASE_ENVIRONMENT, "GPULINK_DASHBOARD_BIND_PORT": "70000"}
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ConfigurationError, "between 1 and 65535"):
                Settings.from_environment()


if __name__ == "__main__":
    unittest.main()
