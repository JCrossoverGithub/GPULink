from __future__ import annotations

import json
import socket
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import Settings


class GpuLinkApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class GpuLinkClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def health(self) -> dict[str, Any]:
        return self._get_json("/healthz")

    def workers(self) -> dict[str, Any]:
        return self._get_json("/v1/workers", token=self._settings.admin_token)

    def jobs(self, *, limit: int = 100) -> dict[str, Any]:
        query = urlencode({"limit": limit})
        return self._get_json(f"/v1/jobs?{query}", token=self._settings.client_token)

    def _get_json(self, path: str, *, token: str | None = None) -> dict[str, Any]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "gpulink-dashboard/0.1.0",
        }
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"

        request = Request(
            f"{self._settings.control_plane_url}{path}",
            headers=headers,
            method="GET",
        )

        try:
            with urlopen(request, timeout=self._settings.request_timeout_seconds) as response:
                content = response.read()
        except HTTPError as error:
            message = _error_message(error)
            raise GpuLinkApiError(message, status_code=error.code) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise GpuLinkApiError("GPUlink control plane is unavailable") from error

        try:
            decoded = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GpuLinkApiError("GPUlink returned an invalid JSON response") from error
        if not isinstance(decoded, dict):
            raise GpuLinkApiError("GPUlink returned an unexpected response shape")
        return decoded


def _error_message(error: HTTPError) -> str:
    try:
        payload = json.loads(error.read())
    except (UnicodeDecodeError, json.JSONDecodeError):
        return f"GPUlink returned HTTP {error.code}"
    message = payload.get("error", {}).get("message") if isinstance(payload, dict) else None
    return message if isinstance(message, str) else f"GPUlink returned HTTP {error.code}"
