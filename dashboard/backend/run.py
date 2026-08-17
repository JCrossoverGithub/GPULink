from gpulink_dashboard import create_app
from gpulink_dashboard.config import Settings


settings = Settings.from_environment()
app = create_app(settings=settings)


if __name__ == "__main__":
    app.run(
        host=settings.bind_host,
        port=settings.bind_port,
        debug=False,
    )
