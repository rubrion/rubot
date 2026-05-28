"""Agent dependencies — injected into every tool / prompt callback.

`tenant_id` and `data_bearer` come from request headers. Add any
per-request state your tools need here (preloaded data, http client,
etc.). Keep it small — the deps object is rebuilt on every request.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field


class AgentDeps(BaseModel):
    tenant_id: str
    data_bearer: str = ""
    reference_date: date = Field(default_factory=date.today)
    # TODO: add provider-specific deps here if needed
    # e.g. preloaded_records: list[dict] = Field(default_factory=list)
    preloaded_context: Optional[dict] = None
