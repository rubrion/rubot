"""Run the LLM routing planner from OpenAI-format chat messages.

Mirrors the role of the per-agent ``app/agent/runner.py`` files in specialist
agents: orchestrates history + agent and returns a
:class:`~app.routing_models.RoutingPlan`.
"""

from __future__ import annotations

import json

import httpx
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from app.capabilities_client import AgentCapabilities
from app.config import settings
from app.planner_agent import (
    PLANNER_RECENT_USER_TURNS,
    PlannerDeps,
    build_routing_planner_agent,
)
from app.routing_models import RoutingPlan

_FINAL_USER_PROMPT = (
    "Output only the RoutingPlan JSON object, per the instructions above, "
    "for the **last user message** in the history."
)


def _message_text(m: dict) -> str | None:
    raw = m.get("content")
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _recent_turns_chat_messages(
    messages: list[dict], *, max_turns: int
) -> list[dict[str, str]]:
    """
    Last `max_turns` user->assistant rounds as OpenAI chat messages (each round
    starts at `user`; optional `assistant` immediately after). Skips empty content.
    """
    msgs = messages or []
    pairs: list[tuple[dict, dict | None]] = []
    i = 0
    while i < len(msgs):
        m = msgs[i]
        if str(m.get("role", "")).lower() != "user":
            i += 1
            continue
        user_m = m
        assistant_m = None
        if (
            i + 1 < len(msgs)
            and str(msgs[i + 1].get("role", "")).lower() == "assistant"
        ):
            assistant_m = msgs[i + 1]
            i += 2
        else:
            i += 1
        pairs.append((user_m, assistant_m))

    out: list[dict[str, str]] = []
    for user_m, assistant_m in pairs[-max_turns:]:
        u_text = _message_text(user_m)
        if u_text:
            out.append({"role": "user", "content": u_text})
        if assistant_m is not None:
            a_text = _message_text(assistant_m)
            if a_text:
                out.append({"role": "assistant", "content": a_text})
    return out


def _conversation_to_model_history(
    conversation_messages: list[dict[str, str]],
) -> list[ModelMessage]:
    history: list[ModelMessage] = []
    for m in conversation_messages:
        role = (m.get("role") or "").lower().strip()
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=content)]))
    return history


async def plan_with_agent(
    *,
    messages: list[dict],
    capabilities: list[AgentCapabilities],
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout_seconds: float | None = None,
) -> RoutingPlan:
    """
    Run the planner agent with structured output validated as RoutingPlan.

    Model, URL, key and timeout default to values in :func:`app.config.settings`
    (the ``PLANNER_*`` env vars). Optional parameters override for tests or
    future per-call injection.
    """
    model_id = model if model is not None else settings.PLANNER_MODEL
    api = api_key if api_key is not None else settings.PLANNER_API_KEY
    base = base_url if base_url is not None else settings.PLANNER_BASE_URL
    timeout = (
        timeout_seconds
        if timeout_seconds is not None
        else settings.PLANNER_TIMEOUT_SECONDS
    )
    caps_payload = [
        {"source_id": c.source_id, "name": c.name, "summary": c.summary}
        for c in capabilities
    ]
    deps = PlannerDeps(
        capabilities_json=json.dumps(caps_payload, ensure_ascii=False),
    )

    conversation_messages = _recent_turns_chat_messages(
        messages, max_turns=PLANNER_RECENT_USER_TURNS
    )
    message_history = _conversation_to_model_history(conversation_messages)

    async with httpx.AsyncClient(timeout=timeout) as http_client:
        agent = build_routing_planner_agent(
            model_id=model_id,
            base_url=base,
            api_key=api,
            http_client=http_client,
        )

        try:
            result = await agent.run(
                _FINAL_USER_PROMPT,
                deps=deps,
                message_history=message_history or None,
            )
        except Exception as e:
            raise ValueError(f"Planner LLM run failed: {e}") from e

    out = result.output
    if out is None:
        raise ValueError("Planner returned empty output")
    return out
