from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class ProviderConnection:
    provider: str
    connected: bool
    expired: bool

    @property
    def available(self) -> bool:
        return bool(self.connected) and not bool(self.expired)


@dataclass(frozen=True)
class AvailableSources:
    providers: frozenset[str]
    # provider -> client_slug for custom integrations. Empty for first-class
    # providers. The orchestrator does not interpret provider names — it just
    # forwards them as identifiers.
    custom_slugs: dict[str, str]
    # Per-tenant enabled-agent allow-list, sourced from the dashboard's
    # tenant_agents table via the preflight `agents` array. An empty set
    # means "no per-tenant override exists" — caller treats this as
    # "every registered agent is allowed" for back-compat with middlewares
    # that don't return the field.
    enabled_agents: frozenset[str]


class ConnectionsCache:
    def __init__(self, ttl_seconds: int = 120) -> None:
        self._ttl_seconds = ttl_seconds
        self._cache: dict[str, tuple[float, AvailableSources]] = {}

    def clear(self) -> None:
        self._cache.clear()

    def get(self, tenant_id: str) -> AvailableSources | None:
        now = time.time()
        cached = self._cache.get(tenant_id)
        if not cached:
            return None
        if (now - cached[0]) > self._ttl_seconds:
            return None
        return cached[1]

    def set(self, tenant_id: str, value: AvailableSources) -> None:
        self._cache[tenant_id] = (time.time(), value)


def _unwrap(payload: Any) -> dict[str, Any]:
    """
    Tolerate both response shapes: the historical `{success, data: {...}}`
    envelope used by /api/auth + /api/tenant, and the bare-object shape
    used by /api/data/:tenantId/connections. Returns the inner object in
    both cases.
    """
    if not isinstance(payload, dict):
        raise ValueError("Unexpected middleware response (not a JSON object)")
    inner = payload.get("data")
    if isinstance(inner, dict):
        return inner
    return payload


async def fetch_available_providers(
    *,
    base_url: str,
    tenant_id: str,
    tenant_secret_bearer: str,
    timeout_seconds: float = 10.0,
) -> AvailableSources:
    """
    Calls the rubot-middleware preflight:
      GET {base_url}/api/data/{tenant_id}/connections
      Authorization: Bearer <tenant_secret>  (only in bearer mode)

    Returns provider identifiers, custom-integration slug map for entries
    flagged `"custom": true`, and the per-tenant enabled-agent allow-list
    derived from the response's `agents` array.
    """
    url = base_url.rstrip("/") + f"/api/data/{tenant_id}/connections"
    headers: dict[str, str] = {}
    if tenant_secret_bearer:
        headers["Authorization"] = f"Bearer {tenant_secret_bearer}"

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        r = await client.get(url, headers=headers)
        r.raise_for_status()
        payload: Any = r.json()

    data = _unwrap(payload)

    conns = data.get("connections") or []
    if not isinstance(conns, list):
        raise ValueError("Unexpected middleware response (connections not a list)")

    providers: set[str] = set()
    custom_slugs: dict[str, str] = {}
    for item in conns:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider", "")).strip().lower()
        if not provider:
            continue
        connected = bool(item.get("connected", False))
        expired = bool(item.get("expired", False))
        if not (connected and not expired):
            continue
        providers.add(provider)
        if bool(item.get("custom", False)):
            slug = str(item.get("client_slug", "")).strip()
            if slug:
                custom_slugs[provider] = slug

    agents_raw = data.get("agents") or []
    enabled_agents: set[str] = set()
    if isinstance(agents_raw, list):
        for item in agents_raw:
            if not isinstance(item, dict):
                continue
            if not item.get("enabled", False):
                continue
            agent_id = str(item.get("agent_id", "")).strip()
            if agent_id:
                enabled_agents.add(agent_id)

    return AvailableSources(
        providers=frozenset(providers),
        custom_slugs=custom_slugs,
        enabled_agents=frozenset(enabled_agents),
    )
