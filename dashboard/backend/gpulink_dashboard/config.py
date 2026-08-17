from __future__ import annotations

from dataclasses import dataclass
import os
from urllib.parse import urlparse


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    control_plane_url: str
    admin_token: str
    client_token: str
    bind_host: str = "127.0.0.1"
    bind_port: int = 5050
    request_timeout_seconds: float = 10.0

    @classmethod
    def from_environment(cls) -> "Settings":
        control_plane_url = _required_environment("GPULINK_URL").rstrip("/")
        admin_token = _required_environment("GPULINK_ADMIN_TOKEN")
        client_token = _required_environment("GPULINK_CLIENT_TOKEN")

        parsed_url = urlparse(control_plane_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise ConfigurationError("GPULINK_URL must be an absolute HTTP(S) URL")
        if len(admin_token) < 32:
            raise ConfigurationError("GPULINK_ADMIN_TOKEN must be at least 32 characters")
        if len(client_token) < 32:
            raise ConfigurationError("GPULINK_CLIENT_TOKEN must be at least 32 characters")

        bind_host = os.environ.get("GPULINK_DASHBOARD_BIND_HOST", "127.0.0.1").strip()
        if not bind_host:
            raise ConfigurationError("GPULINK_DASHBOARD_BIND_HOST cannot be empty")

        bind_port = _integer_environment("GPULINK_DASHBOARD_BIND_PORT", 5050, 1, 65_535)
        timeout = _float_environment("GPULINK_DASHBOARD_TIMEOUT_SECONDS", 10.0, 0.1, 60.0)

        return cls(
            control_plane_url=control_plane_url,
            admin_token=admin_token,
            client_token=client_token,
            bind_host=bind_host,
            bind_port=bind_port,
            request_timeout_seconds=timeout,
        )


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def _integer_environment(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _float_environment(name: str, default: float, minimum: float, maximum: float) -> float:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if value < minimum or value > maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value
