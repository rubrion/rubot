"""Pydantic AI agent for rubot-conversational.

Subclasses rubot_config.BaseAgent for YAML/env-driven model config
and auto-emitted agent_log_v1 payloads. The system prompt is built
dynamically from prompt.txt with injected capabilities and date.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from rubot_config import BaseAgent
from pydantic_ai import RunContext

from app.agent.deps import AgentDeps

_PROMPT_TEMPLATE = (Path(__file__).resolve().parent.parent / "prompt.txt").read_text(
    encoding="utf-8"
)


class ConversationalAgent(BaseAgent):
    agent_name = "conversational"


conversational_agent = ConversationalAgent(deps_type=AgentDeps, output_type=str)


@conversational_agent.system_prompt
def _system_prompt(ctx: RunContext[AgentDeps]) -> str:
    ref = ctx.deps.reference_date or date.today()

    caps = ctx.deps.available_capabilities or []
    if caps:
        capabilities_text = "\n".join(f"- {name}: {summary}" for name, summary in caps)
    else:
        capabilities_text = "- No data endpoints connected at this time."

    return _PROMPT_TEMPLATE.format(
        available_capabilities=capabilities_text,
        reference_date=ref.isoformat(),
    )
