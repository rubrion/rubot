"""Service-level settings. Read from env / .env file.

TODO when forking:
  - rename TEMPLATE_API_KEY / TEMPLATE_BASE_URL to your provider's name
  - drop anything you don't need
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Auth from the rubot orchestrator (required in prod, optional in dev)
    ORCHESTRATOR_API_KEY: str = ""

    # Data auth mode: "bearer" (minted bearers required) or "open" (no auth).
    RUBOT_DATA_AUTH: str = "bearer"

    # Upstream data middleware used by tools to fetch tenant data.
    MIDDLEWARE_BASE_URL: str = "http://localhost:8787"

    # ---- TODO: replace with your provider's config ----
    TEMPLATE_API_KEY: str = ""
    TEMPLATE_BASE_URL: str = "https://api.example.com"

    api_title: str = "Rubot Agent Template"
    api_description: str = "Scaffold agent — fork this to add a new provider."
    api_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()
