from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    RUBOT_DATA_AUTH: str = "bearer"
    GATEWAY_API_KEY: str = ""
    ORCHESTRATOR_URL: str = ""
    ORCHESTRATOR_API_KEY: str = ""

    OPENAI_API_KEY: str = ""

    api_title: str = "Rubot Guardrails Service"
    api_description: str = (
        "Input/output guardrails wrapping the orchestrator pipeline"
    )
    api_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()
