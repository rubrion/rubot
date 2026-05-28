import pytest
import respx

from app.config import settings
from app.router import route


def _mock_openai_chat_completion(content: str) -> dict:
    """Full envelope required by the OpenAI / pydantic-ai client validation."""
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "gpt-test",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": content},
            }
        ],
    }


@pytest.mark.asyncio
async def test_single_source_planner_routes_and_attribution(monkeypatch):
    # avoid cross-test cache effects
    import app.router as router_mod

    router_mod._connections_cache.clear()
    router_mod._caps_cache.clear()

    monkeypatch.setattr(settings, "MIDDLEWARE_URL", "https://mw.local")
    monkeypatch.setattr(settings, "PLANNER_BASE_URL", "https://planner.local")
    monkeypatch.setattr(settings, "PLANNER_API_KEY", "k")
    monkeypatch.setattr(settings, "PLANNER_MODEL", "gpt-test")
    monkeypatch.setattr(
        settings,
        "AGENT_REGISTRY_JSON",
        '{"example-provider":"https://example.local","other-provider":"https://other.local"}',
    )

    with respx.mock(assert_all_called=False) as rsps:
        rsps.get("https://mw.local/api/data/t1/connections").respond(
            200,
            json={
                "success": True,
                "data": {
                    "connections": [
                        {
                            "provider": "example-provider",
                            "connected": True,
                            "expired": False,
                        }
                    ]
                },
            },
        )
        rsps.get("https://example.local/v1/capabilities").respond(
            200,
            json={
                "schema_version": "1",
                "source_id": "example-provider",
                "name": "Example",
                "summary": "Example provider telemetry",
            },
        )
        rsps.post("https://planner.local/v1/chat/completions").respond(
            200,
            json=_mock_openai_chat_completion(
                '{"schema_version":"1","strategy":"single","selected_sources":["example-provider"],'
                '"slices":[{"id":"s1","source_id":"example-provider","instructions":"ask example","carry_over_context":{},"depends_on":[]}]}'
            ),
        )
        rsps.post("https://example.local/v1/chat/completions").respond(
            200,
            json={"choices": [{"message": {"content": "ok-example"}}]},
        )

        resp = await route(
            [{"role": "user", "content": "What was the consumption today?"}],
            tenant_id="t1",
            data_bearer="secret",
        )

    content = resp["choices"][0]["message"]["content"]
    assert "*Agent Example-provider*" not in content
    assert content.strip() == "ok-example"


@pytest.mark.asyncio
async def test_multi_source_planner_fanout_and_merge(monkeypatch):
    # avoid cross-test cache effects
    import app.router as router_mod

    router_mod._connections_cache.clear()
    router_mod._caps_cache.clear()

    monkeypatch.setattr(settings, "MIDDLEWARE_URL", "https://mw.local")
    monkeypatch.setattr(settings, "PLANNER_BASE_URL", "https://planner.local")
    monkeypatch.setattr(settings, "PLANNER_API_KEY", "k")
    monkeypatch.setattr(settings, "PLANNER_MODEL", "gpt-test")
    monkeypatch.setattr(
        settings,
        "AGENT_REGISTRY_JSON",
        '{"example-provider":"https://example.local","other-provider":"https://other.local"}',
    )

    with respx.mock(assert_all_called=False) as rsps:
        rsps.get("https://mw.local/api/data/t1/connections").respond(
            200,
            json={
                "success": True,
                "data": {
                    "connections": [
                        {
                            "provider": "example-provider",
                            "connected": True,
                            "expired": False,
                        },
                        {
                            "provider": "other-provider",
                            "connected": True,
                            "expired": False,
                        },
                    ]
                },
            },
        )
        rsps.get("https://example.local/v1/capabilities").respond(
            200,
            json={
                "schema_version": "1",
                "source_id": "example-provider",
                "name": "Example",
                "summary": "Telemetry",
            },
        )
        rsps.get("https://other.local/v1/capabilities").respond(
            200,
            json={
                "schema_version": "1",
                "source_id": "other-provider",
                "name": "Other",
                "summary": "Alerts",
            },
        )
        rsps.post("https://planner.local/v1/chat/completions").respond(
            200,
            json=_mock_openai_chat_completion(
                '{"schema_version":"1","strategy":"multi","selected_sources":["example-provider","other-provider"],'
                '"slices":[{"id":"s1","source_id":"example-provider","instructions":"ask example","carry_over_context":{},"depends_on":[]},'
                '{"id":"s2","source_id":"other-provider","instructions":"ask other","carry_over_context":{},"depends_on":[]}]}'
            ),
        )
        rsps.post("https://example.local/v1/chat/completions").respond(
            200,
            json={"choices": [{"message": {"content": "ok-example"}}]},
        )
        rsps.post("https://other.local/v1/chat/completions").respond(
            200,
            json={"choices": [{"message": {"content": "ok-other"}}]},
        )

        resp = await route(
            [{"role": "user", "content": "Status report across providers"}],
            tenant_id="t1",
            data_bearer="secret",
        )

    content = resp["choices"][0]["message"]["content"]
    assert "*Agent Example-provider*" in content
    assert "*Agent Other-provider*" in content
    assert "ok-example" in content
    assert "ok-other" in content


@pytest.mark.asyncio
async def test_partial_failure_merges_success_and_note(monkeypatch):
    # avoid cross-test cache effects
    import app.router as router_mod

    router_mod._connections_cache.clear()
    router_mod._caps_cache.clear()

    monkeypatch.setattr(settings, "MIDDLEWARE_URL", "https://mw.local")
    monkeypatch.setattr(settings, "PLANNER_BASE_URL", "https://planner.local")
    monkeypatch.setattr(settings, "PLANNER_API_KEY", "k")
    monkeypatch.setattr(settings, "PLANNER_MODEL", "gpt-test")
    monkeypatch.setattr(
        settings,
        "AGENT_REGISTRY_JSON",
        '{"example-provider":"https://example.local","other-provider":"https://other.local"}',
    )

    with respx.mock(assert_all_called=False) as rsps:
        rsps.get("https://mw.local/api/data/t1/connections").respond(
            200,
            json={
                "success": True,
                "data": {
                    "connections": [
                        {
                            "provider": "example-provider",
                            "connected": True,
                            "expired": False,
                        },
                        {
                            "provider": "other-provider",
                            "connected": True,
                            "expired": False,
                        },
                    ]
                },
            },
        )
        rsps.get("https://example.local/v1/capabilities").respond(
            200,
            json={
                "schema_version": "1",
                "source_id": "example-provider",
                "name": "Example",
                "summary": "Telemetry",
            },
        )
        rsps.get("https://other.local/v1/capabilities").respond(
            200,
            json={
                "schema_version": "1",
                "source_id": "other-provider",
                "name": "Other",
                "summary": "Alerts",
            },
        )
        rsps.post("https://planner.local/v1/chat/completions").respond(
            200,
            json=_mock_openai_chat_completion(
                '{"schema_version":"1","strategy":"multi","selected_sources":["example-provider","other-provider"],'
                '"slices":[{"id":"s1","source_id":"example-provider","instructions":"ask example","carry_over_context":{},"depends_on":[]},'
                '{"id":"s2","source_id":"other-provider","instructions":"ask other","carry_over_context":{},"depends_on":[]}]}'
            ),
        )
        rsps.post("https://example.local/v1/chat/completions").respond(
            200,
            json={"choices": [{"message": {"content": "ok-example"}}]},
        )
        rsps.post("https://other.local/v1/chat/completions").respond(
            500, json={"err": "no"}
        )

        resp = await route(
            [{"role": "user", "content": "status across providers"}],
            tenant_id="t1",
            data_bearer="secret",
        )

    content = resp["choices"][0]["message"]["content"]
    assert "ok-example" in content
    assert "Could not reach" in content
