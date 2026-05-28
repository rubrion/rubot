from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class AgentCapabilities:
    schema_version: str
    source_id: str
    name: str
    summary: str


class CapabilitiesCache:
    def __init__(self, ttl_seconds: int = 1800) -> None:
        self._ttl_seconds = ttl_seconds
        self._lock = asyncio.Lock()
        self._cache: dict[str, tuple[float, AgentCapabilities]] = {}
        self._failed_at: dict[str, float] = {}

    def clear(self) -> None:
        self._cache.clear()
        self._failed_at.clear()

    async def get_many(
        self,
        *,
        registry: dict[str, str],
        tenant_id: str,
        orchestrator_api_key: str,
        timeout_seconds: float = 15.0,
    ) -> tuple[dict[str, AgentCapabilities], set[str]]:
        now = time.time()
        ok: dict[str, AgentCapabilities] = {}
        failed: set[str] = set()

        async with self._lock:
            for source_id, url in registry.items():
                cached = self._cache.get(source_id)
                if cached and (now - cached[0]) < self._ttl_seconds:
                    ok[source_id] = cached[1]
                else:
                    failed.add(source_id)

        if not failed:
            return ok, set()

        headers = {
            "X-Tenant-Id": tenant_id,
        }
        if orchestrator_api_key:
            headers["Authorization"] = f"Bearer {orchestrator_api_key}"

        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            tasks = []
            for source_id in failed:
                url = registry[source_id]
                tasks.append(
                    _fetch_caps(client, source_id=source_id, base_url=url, headers=headers)
                )
            results = await asyncio.gather(*tasks, return_exceptions=True)

        fetched_ok: dict[str, AgentCapabilities] = {}
        fetched_failed: set[str] = set()
        for r in results:
            if isinstance(r, Exception):
                continue
            if r is None:
                continue
            fetched_ok[r.source_id] = r

        for source_id in failed:
            if source_id not in fetched_ok:
                fetched_failed.add(source_id)

        async with self._lock:
            now2 = time.time()
            for source_id, caps in fetched_ok.items():
                self._cache[source_id] = (now2, caps)
                self._failed_at.pop(source_id, None)
            for source_id in fetched_failed:
                self._failed_at[source_id] = now2

            ok.update(fetched_ok)

        return ok, fetched_failed


async def _fetch_caps(
    client: httpx.AsyncClient,
    *,
    source_id: str,
    base_url: str,
    headers: dict[str, str],
) -> AgentCapabilities | None:
    try:
        r = await client.get(f"{base_url}/v1/capabilities", headers=headers)
        r.raise_for_status()
        data: Any = r.json()

        if not isinstance(data, dict):
            return None

        if str(data.get("schema_version", "")) != "1":
            return None

        if str(data.get("source_id", "")).strip().lower() != source_id:
            return None

        return AgentCapabilities(
            schema_version="1",
            source_id=source_id,
            name=str(data.get("name", "")),
            summary=str(data.get("summary", "")),
        )
    except Exception:
        return None
