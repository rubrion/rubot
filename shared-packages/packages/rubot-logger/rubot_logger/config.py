from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class LoggerConfig:
    service: str
    environment: str
    deployment_hash: str


_config: LoggerConfig | None = None


def configure(
    *,
    service: str | None = None,
    environment: str | None = None,
    deployment_hash: str | None = None,
) -> LoggerConfig:
    global _config
    _config = LoggerConfig(
        service=service or os.environ.get("RUBOT_SERVICE_NAME", "unknown"),
        environment=environment or os.environ.get("RUBOT_ENVIRONMENT", "dev"),
        deployment_hash=deployment_hash or os.environ.get(
            "RUBOT_DEPLOYMENT_HASH",
            os.environ.get("RAILWAY_GIT_COMMIT_SHA", ""),
        )[:12],
    )
    return _config


def get_config() -> LoggerConfig:
    global _config
    if _config is None:
        return configure()
    return _config
