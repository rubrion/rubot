"""Glue between the OpenAI-compatible HTTP layer and the Pydantic AI agent.

Reusable across agents — typically only the import of the agent and
the deps construction need editing.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from rubot_logger import get_logger
from pydantic import BaseModel

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


async def run_agent(
    messages: list[dict],
    tenant_id: str,
    data_bearer: str,
) -> AgentResult:
    from app.agent.deps import AgentDeps
    from app.agent.template_agent import template_agent

    deps = AgentDeps(
        tenant_id=tenant_id,
        data_bearer=data_bearer,
        reference_date=date.today(),
    )
    user_prompt, message_history = _openai_messages_to_agent_format(messages)

    result = await template_agent.run(
        user_prompt,
        deps=deps,
        message_history=message_history or None,
    )

    return AgentResult(content=result.output or "")
