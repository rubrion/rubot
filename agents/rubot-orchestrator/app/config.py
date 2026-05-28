from __future__ import annotations

import json
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Data auth mode: "bearer" (minted bearers required) or "open" (no auth).
    RUBOT_DATA_AUTH: str = "bearer"

    # Inbound auth — must match the gateway's outbound key when calling us.
    GATEWAY_API_KEY: str = ""
    # Outbound auth — specialist agents validate this when we call them.
    ORCHESTRATOR_API_KEY: str = ""

    # JSON map of {agent_id: base_url}, e.g.
    #   {"agent-template":"https://template.internal"}
    # The orchestrator does not hard-code agent names — they come from here
    # and capabilities are discovered dynamically via GET /v1/capabilities.
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

    # Middleware connections preflight — base URL of rubot-middleware.
    MIDDLEWARE_URL: str = "http://localhost:8787"

    # --- Planner routing LLM (OpenAI-compatible Chat Completions) ---
    # Swap model/provider here; runner/planner_agent consume these via settings.
    PLANNER_BASE_URL: str = "https://api.openai.com"
    PLANNER_API_KEY: str = ""
    PLANNER_MODEL: str = "gpt-4o-mini"
    PLANNER_TIMEOUT_SECONDS: float = 20.0

    api_title: str = "Rubot Orchestrator"
    api_description: str = (
        "Gateway-facing orchestrator — routes requests to specialist agents."
    )
    api_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8001


settings = Settings()
