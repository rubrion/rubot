"""Agent dependencies -- injected into every tool / prompt callback.

`tenant_id` and `data_bearer` come from request headers.
`available_capabilities` is populated at runtime by querying sibling
agents and the middleware for connected data sources.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field


class AgentDeps(BaseModel):
    tenant_id: str
    data_bearer: str = ""
    reference_date: date = Field(default_factory=date.today)
    available_capabilities: Optional[list[tuple[str, str]]] = None
