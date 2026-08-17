from typing import Any


def create_app(*args: Any, **kwargs: Any):
    from .app import create_app as app_factory

    return app_factory(*args, **kwargs)


__all__ = ["create_app"]
