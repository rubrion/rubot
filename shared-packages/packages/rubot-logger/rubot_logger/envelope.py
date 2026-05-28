from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

LogLevel = Literal["DEBUG", "INFO", "WARN", "ERROR"]


class ErrorDetail(BaseModel):
    type: str
    message: str
    stack: str | None = None


class LogEnvelope(BaseModel):
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    log_level: LogLevel
    service: str
    component: str
    environment: str
    deployment_hash: str = ""
    tenant_id: str | None = None
    sender_id: str | None = None
    chat_source_session_id: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    event_type: str
    message: str
    error: ErrorDetail | None = None
    extra: dict[str, Any] = Field(default_factory=dict)
    agent: dict[str, Any] | None = None
