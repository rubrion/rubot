"""Example tool — fetches tenant data from the rubot middleware.

Pattern to copy for your real tools:
  1. Read tenant_id / data_bearer from RunContext deps
  2. Build the httpx call with _forward_trace_headers()
  3. Return a small dict / Pydantic model — never raw HTTP
"""

from __future__ import annotations

from typing import Any

import httpx
from rubot_logger import get_logger, trace_id_var
from pydantic_ai import RunContext

from app.agent.deps import AgentDeps
from app.config import settings

logger = get_logger(__name__)


def _forward_trace_headers(base: dict[str, str] | None = None) -> dict[str, str]:
    """Forward trace_id to upstream calls so logs across services share one id."""
    headers = dict(base or {})
    tid = trace_id_var.get()
    if tid:
        headers["X-Rubot-Trace-Id"] = tid
    return headers


async def example_fetch_tenant_summary(
    ctx: RunContext[AgentDeps],
) -> dict[str, Any]:
    """Example: fetch summary data for the current tenant.

    Replace with real provider calls. Demonstrates:
      - reading tenant_id / data_bearer from deps
      - forwarding trace_id to upstream
      - structured logging
    """
    url = (
        settings.MIDDLEWARE_BASE_URL.rstrip("/")
        + f"/api/data/{ctx.deps.tenant_id}/summary"
    )
    headers = _forward_trace_headers()
    if ctx.deps.data_bearer:
        headers["Authorization"] = f"Bearer {ctx.deps.data_bearer}"

    logger.info(
        "tool.call.started",
        "fetching tenant summary",
        extra={"tool": "example_fetch_tenant_summary", "url": url},
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()

        logger.info(
            "tool.call.completed",
            "tenant summary ok",
            extra={"tool": "example_fetch_tenant_summary"},
        )
        return data
    except Exception as exc:
        logger.error(
            "tool.call.failed",
            "tenant summary fetch failed",
            error=exc,
            extra={"tool": "example_fetch_tenant_summary", "url": url},
        )
        return {"error": "upstream_unavailable"}
