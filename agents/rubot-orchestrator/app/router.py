"""Route incoming requests to the appropriate specialist agent(s)."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from rubot_logger import get_logger

from app.capabilities_client import CapabilitiesCache
from app.config import settings
from app.middleware_client import (
    AvailableSources,
    ConnectionsCache,
    fetch_available_providers,
)
from app.routing_models import RoutingPlan, assert_plan_sources_known
from app.runner import plan_with_agent

logger = get_logger(__name__)

_caps_cache = CapabilitiesCache(ttl_seconds=1800)
_connections_cache = ConnectionsCache(ttl_seconds=120)

# Agent identifiers that are routable even when the tenant has no data
# providers connected (e.g. a purely conversational agent).
_PROVIDER_INDEPENDENT_SOURCES = {"conversational"}


def _openai_envelope(*, content: str, model: str = "orchestrator") -> dict[str, Any]:
    now = int(time.time())
    return {
        "id": f"chatcmpl-orchestrator-{now}",
        "object": "chat.completion",
        "created": now,
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


async def call_agent(
    source_id: str,
    messages: list[dict],
    tenant_id: str,
    data_bearer: str,
    custom_integration_slug: str | None = None,
) -> dict[str, Any]:
    """Forward a chat completion request to the named specialist agent.

    Looks up the URL from the registry built from env vars. Raises ValueError
    if the agent id has no registered URL.
    """
    url = settings.agent_registry.get(source_id)
    if not url:
        raise ValueError(
            f"No URL registered for agent '{source_id}'. "
            "Set AGENT_REGISTRY_JSON in the environment."
        )

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.ORCHESTRATOR_API_KEY}",
        "X-Tenant-Id": tenant_id,
    }
    if data_bearer:
        headers["X-Rubot-Data-Bearer"] = data_bearer
    if custom_integration_slug:
        headers["X-Rubot-Integration-Slug"] = custom_integration_slug
    payload = {"messages": messages, "model": source_id, "stream": False}

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            f"{url}/v1/chat/completions",
            json=payload,
            headers=headers,
        )
        if response.status_code >= 400:
            logger.error(
                "agent.call.error",
                f"{source_id} returned {response.status_code}",
                extra={
                    "agent_id": source_id,
                    "status_code": response.status_code,
                    "body": response.text[:500],
                },
            )
        response.raise_for_status()
        return response.json()


def _extract_content(resp: dict[str, Any]) -> str:
    try:
        return str(resp["choices"][0]["message"]["content"] or "")
    except Exception:
        return ""


def _agent_display_label(source_id: str) -> str:
    """Human-facing agent name: id with first letter upper, prefixed with 'Agent'."""
    if not source_id:
        return "Agent"
    titled = source_id[0].upper() + source_id[1:]
    return f"Agent {titled}"


def _format_source_block(source_id: str, content: str) -> str:
    """Merge shape: *Agent Name* then body (readable in chat UIs that render markdown)."""
    label = _agent_display_label(source_id)
    return f"*{label}*\n{content}".strip()


def _merge_contents(parts: list[tuple[str, str]]) -> str:
    if not parts:
        return "Could not reach any agent right now."

    # Single source: UI already shows an agent header; skip body prefix to avoid duplication.
    if len(parts) == 1:
        return parts[0][1].strip()

    blocks = [_format_source_block(sid, c) for sid, c in parts]
    return "\n\n".join(blocks).strip()


# Middleware `provider` and agent registry keys share the same identifier (1:1).
# For custom integrations the `provider` is the integration_type (e.g. "pims")
# and the actual per-tenant slug is carried separately in custom_slugs.
async def _available_source_ids(
    *,
    tenant_id: str,
    data_bearer: str,
) -> AvailableSources:
    cached = _connections_cache.get(tenant_id)
    if cached is not None:
        return cached

    result = await fetch_available_providers(
        base_url=settings.MIDDLEWARE_URL,
        tenant_id=tenant_id,
        tenant_secret_bearer=data_bearer,
    )
    _connections_cache.set(tenant_id, result)
    return result


async def _build_plan(
    *,
    messages: list[dict],
    tenant_id: str,
    available_sources: set[str],
) -> RoutingPlan:
    registry = settings.agent_registry
    caps_ok, caps_failed = await _caps_cache.get_many(
        registry=registry,
        tenant_id=tenant_id,
        orchestrator_api_key=settings.ORCHESTRATOR_API_KEY,
    )

    # Planner only receives capabilities we successfully fetched and that are available.
    capabilities = [c for sid, c in caps_ok.items() if sid in available_sources]

    if not settings.PLANNER_API_KEY:
        raise ValueError("Planner routing requires PLANNER_API_KEY")
    if not capabilities:
        raise ValueError("No capabilities available for planner routing")

    plan = await plan_with_agent(messages=messages, capabilities=capabilities)

    # Fail closed if planner/rules referenced unknown sources.
    assert_plan_sources_known(plan, registry)
    # Filter plan sources to availability (conservative).
    if any(s not in available_sources for s in plan.selected_sources):
        raise ValueError("Plan selected a source not available for this tenant")

    if caps_failed:
        logger.warn(
            "capabilities.partial",
            "Some agents did not return capabilities",
            extra={"agents_failed": sorted(caps_failed)},
        )

    return plan


async def route(
    messages: list[dict],
    tenant_id: str,
    data_bearer: str,
) -> dict[str, Any]:
    registry = settings.agent_registry
    if not registry:
        return _openai_envelope(
            content="No agents are registered with the orchestrator at the moment.",
        )

    try:
        available = await _available_source_ids(
            tenant_id=tenant_id,
            data_bearer=data_bearer,
        )
    except Exception as exc:
        logger.error(
            "middleware.preflight.failed",
            f"middleware connections preflight failed for tenant_id={tenant_id}",
            error=exc,
        )
        raise

    available_sources = set(available.providers) | (
        _PROVIDER_INDEPENDENT_SOURCES & set(registry.keys())
    )
    candidate_sources = sorted(set(registry.keys()) & available_sources)

    # Per-tenant agent allow-list from the dashboard's tenant_agents table
    # (delivered via the preflight `agents` array). Empty set means
    # "no override" — every candidate stays. Non-empty means: drop any
    # candidate not on the list.
    if available.enabled_agents:
        candidate_sources = [
            sid for sid in candidate_sources if sid in available.enabled_agents
        ]

    if not candidate_sources:
        return _openai_envelope(
            content=(
                "No data sources are connected/active for this tenant right now. "
                "Connect a provider and try again."
            )
        )

    plan = await _build_plan(
        messages=messages,
        tenant_id=tenant_id,
        available_sources=set(candidate_sources),
    )

    logger.info(
        "routing.plan",
        f"plan strategy={plan.strategy} sources={plan.selected_sources} slices={len(plan.slices)}",
        extra={
            "strategy": plan.strategy,
            "selected_sources": plan.selected_sources,
            "slice_count": len(plan.slices),
        },
    )

    async def _run_slice(
        slice_id: str, source_id: str, instructions: str
    ) -> tuple[str, str]:
        msgs = list(messages)
        last_user_idx = None
        for i in range(len(msgs) - 1, -1, -1):
            if str(msgs[i].get("role", "")).lower() == "user":
                last_user_idx = i
                break
        if last_user_idx is not None:
            msgs = msgs[: last_user_idx + 1]
            msgs[last_user_idx] = {"role": "user", "content": instructions}
        else:
            msgs = [{"role": "user", "content": instructions}]

        try:
            resp = await call_agent(
                source_id,
                msgs,
                tenant_id,
                data_bearer,
                custom_integration_slug=available.custom_slugs.get(source_id),
            )
            return source_id, _extract_content(resp) or ""
        except Exception:
            return source_id, ""

    tasks = [
        _run_slice(s.id, s.source_id, s.instructions)
        for s in plan.slices
        if not s.depends_on
    ]
    results = await asyncio.gather(*tasks)

    parts: list[tuple[str, str]] = []
    failed: list[str] = []
    for source_id, content in results:
        if content.strip():
            parts.append((source_id, content.strip()))
        else:
            failed.append(source_id)

    merged = _merge_contents(parts)
    if failed and parts:
        merged = (
            merged
            + "\n\n"
            + "Could not reach: "
            + ", ".join(sorted(set(failed)))
            + "."
        )

    if not parts:
        raise RuntimeError("all slices failed")

    return _openai_envelope(content=merged)
