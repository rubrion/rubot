from __future__ import annotations

import json
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    RUBOT_DATA_AUTH: str = "bearer"
    MIDDLEWARE_URL: str = "http://localhost:8788"
    ORCHESTRATOR_API_KEY: str = ""
    AGENT_REGISTRY_JSON: str = ""

    @property
    def agent_registry(self) -> dict[str, str]:
        registry: dict[str, str] = {}
        if self.AGENT_REGISTRY_JSON.strip():
            try:
                parsed: Any = json.loads(self.AGENT_REGISTRY_JSON)
                if isinstance(parsed, dict):
                    for k, v in parsed.items():
                        if isinstance(k, str) and isinstance(v, str) and v.strip():
                            registry[k.strip().lower()] = v.strip().rstrip("/")
            except Exception:
                pass
        return registry

    api_title: str = "Rubot Conversational"
    api_description: str = "General-purpose conversational agent"
    api_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()
