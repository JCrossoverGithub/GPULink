from __future__ import annotations

from flask import Flask, jsonify

from .client import GpuLinkApiError, GpuLinkClient
from .config import Settings
from .snapshot import build_snapshot


def create_app(*, settings: Settings, client: GpuLinkClient | None = None) -> Flask:
    app = Flask(__name__)
    app.json.sort_keys = False
    api_client = client or GpuLinkClient(settings)

    @app.after_request
    def secure_response(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/dashboard/health")
    def dashboard_health():
        return jsonify({"status": "ok"})

    @app.get("/api/dashboard/snapshot")
    def dashboard_snapshot():
        try:
            return jsonify(build_snapshot(api_client))
        except GpuLinkApiError as error:
            return jsonify({
                "error": {
                    "code": "upstream_error",
                    "message": str(error),
                },
            }), 502

    return app
