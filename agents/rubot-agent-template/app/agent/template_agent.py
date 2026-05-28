"""Pydantic AI agent for the rubot template agent.

Standard pattern for every rubot specialist agent:
  1. Subclass rubot_config.BaseAgent (gets auto-logged runs + YAML config)
  2. Set agent_name to a unique slug (must match a key in agents.yaml or
     rely on the defaults: block). The slug is also the env-var prefix:
     agent_name="template" -> AGENT_TEMPLATE_MODEL=...
  3. Register tools with @<agent>.tool
  4. Register the system prompt with @<agent>.system_prompt

When forking:
  - rename TemplateAgent -> YourAgent
  - change agent_name="template" to your slug
  - add a YAML block in
    shared-packages/packages/rubot-config/rubot_config/agents.yaml IF
    you need non-default model settings — otherwise the defaults block
    applies
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from rubot_config import BaseAgent
from pydantic_ai import RunContext

from app.agent.deps import AgentDeps
from app.agent.tools import example_fetch_tenant_summary

_PROMPT_TEMPLATE = (Path(__file__).resolve().parent.parent / "prompt.txt").read_text(
    encoding="utf-8"
)


class TemplateAgent(BaseAgent):
    agent_name = "template"


template_agent = TemplateAgent(deps_type=AgentDeps, output_type=str)


@template_agent.system_prompt
def _system_prompt(ctx: RunContext[AgentDeps]) -> str:
    ref = ctx.deps.reference_date or date.today()
    return _PROMPT_TEMPLATE.format(reference_date=ref.isoformat())


# Register tools. Add as many as you need — keep them small and idempotent.
template_agent.tool(example_fetch_tenant_summary)
