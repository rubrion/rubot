"""Glue between the OpenAI-compatible HTTP layer and the Pydantic AI agent.

Fetches connected providers and sibling-agent capabilities at request
time so the system prompt can tell the user what the system offers.
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

import httpx
from rubot_logger import get_logger
from pydantic import BaseModel

from app.config import settings

logger = get_logger(__name__)


class AgentResult(BaseModel):
    content: str


def _openai_messages_to_agent_format(messages: list[dict]) -> tuple[str, list]:
    """Split OpenAI-style messages into (last_user_prompt, prior_history)."""
    if not messages:
        return "", []

    history: list[Any] = []
    for m in messages[:-1]:
        role = (m.get("role") or "").strip().lower()
        content = m.get("content")
        if content is None:
            content = ""
        if isinstance(content, str) and not content.strip():
            continue
        if role == "user":
            from pydantic_ai.messages import ModelRequest, UserPromptPart
            history.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            from pydantic_ai.messages import ModelResponse, TextPart
            history.append(ModelResponse(parts=[TextPart(content=content)]))

    last = messages[-1]
    last_content = last.get("content") or ""
    user_prompt = last_content if isinstance(last_content, str) else str(last_content)
    return user_prompt, history


async def _fetch_connected_providers(
    tenant_id: str,
    data_bearer: str,
) -> set[str]:
    """Ask the middleware which data providers are connected for this tenant."""
    url = settings.MIDDLEWARE_URL.rstrip("/") + f"/api/data/{tenant_id}/connections"
    headers: dict[str, str] = {}
    if data_bearer:
        headers["Authorization"] = f"Bearer {data_bearer}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            payload = r.json()

        conns = payload.get("connections") or []
        return {
            str(item["provider"]).strip().lower()
            for item in conns
            if isinstance(item, dict)
            and item.get("connected")
            and not item.get("expired")
        }
    except Exception:
        logger.warning(
            "connections.fetch.failed",
            "failed to fetch connections",
            extra={"tenant_id": tenant_id},
        )
        return set()


async def _fetch_agent_capabilities(
    source_id: str,
    base_url: str,
    tenant_id: str,
) -> tuple[str, str] | None:
    """Fetch the /v1/capabilities document from a sibling agent."""
    headers = {
        "X-Tenant-Id": tenant_id,
    }
    if settings.ORCHESTRATOR_API_KEY:
        headers["Authorization"] = f"Bearer {settings.ORCHESTRATOR_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{base_url}/v1/capabilities", headers=headers)
            r.raise_for_status()
            data = r.json()

        if not isinstance(data, dict) or str(data.get("schema_version", "")) != "1":
            return None

        name = str(data.get("name", source_id))
        summary = str(data.get("summary", ""))
        if not summary:
            return None

        return name, summary
    except Exception:
        logger.warning(
            "capabilities.fetch.failed",
            "failed to fetch capabilities from sibling agent",
            extra={"source_id": source_id},
        )
        return None


async def _build_available_capabilities(
    tenant_id: str,
    data_bearer: str,
) -> list[tuple[str, str]]:
    """Build the list of (name, summary) for agents whose providers are connected."""
    registry = settings.agent_registry
    if not registry:
        return []

    connected = await _fetch_connected_providers(tenant_id, data_bearer)

    tasks = []
    for source_id, base_url in registry.items():
        if source_id in connected:
            tasks.append(_fetch_agent_capabilities(source_id, base_url, tenant_id))

    if not tasks:
        return []

    results = await asyncio.gather(*tasks)
    return [r for r in results if r is not None]


async def run_agent(
    messages: list[dict],
    tenant_id: str,
    data_bearer: str,
) -> AgentResult:
    from app.agent.deps import AgentDeps
    from app.agent.conversational_agent import conversational_agent

    capabilities = await _build_available_capabilities(tenant_id, data_bearer)

    deps = AgentDeps(
        tenant_id=tenant_id,
        data_bearer=data_bearer,
        reference_date=date.today(),
        available_capabilities=capabilities,
    )
    user_prompt, message_history = _openai_messages_to_agent_format(messages)

    result = await conversational_agent.run(
        user_prompt,
        deps=deps,
        message_history=message_history or None,
    )

    return AgentResult(content=result.output or "")
