"""pydantic-ai routing planner agent for the rubot orchestrator.

Defines dependencies (:class:`PlannerDeps`), the instruction text rendered for
the model, and the :class:`~pydantic_ai.Agent` itself. The planner is given a
JSON list of agent capabilities (one entry per registered specialist agent)
and asked to produce a :class:`~app.routing_models.RoutingPlan`.

See: https://ai.pydantic.dev/agents/#instructions
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.output import PromptedOutput
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings

from app.routing_models import RoutingPlan


@dataclass(frozen=True)
class PlannerDeps:
    """Runtime-only values used to render the instructions for the model."""

    capabilities_json: str


# How many user-initiated turns of history to send to the planner
# (kept in sync with the router).
PLANNER_RECENT_USER_TURNS = 3


def _normalize_openai_compatible_base_url(url: str) -> str:
    """Ensure an OpenAI-client style URL (``.../v1``) for compatible endpoints."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return "https://api.openai.com/v1"
    if not u.endswith("/v1"):
        return f"{u}/v1"
    return u


def build_routing_planner_agent(
    *,
    model_id: str,
    base_url: str,
    api_key: str,
    http_client: httpx.AsyncClient,
) -> Agent:
    """Build the agent against an OpenAI-compatible HTTP endpoint."""
    provider = OpenAIProvider(
        api_key=api_key,
        base_url=_normalize_openai_compatible_base_url(base_url),
        http_client=http_client,
    )
    model = OpenAIModel(model_id, provider=provider)
    return _create_routing_planner_agent(model)


def routing_planner_rules_and_schema_section() -> str:
    """Fixed rules and example schema for a RoutingPlan."""
    return (
        "You are the routing planner of a multi-agent system.\n"
        "Reply ONLY with valid JSON matching the RoutingPlan schema.\n"
        "Rules:\n"
        "- Never invent agents that do not appear in the capabilities list provided.\n"
        "- Use the chat history as context; routing must consider the **last user message**.\n"
        '- Prefer strategy="single" whenever it makes sense.\n'
        '- Use strategy="multi" only when there are clearly distinct intents.\n'
        "- Keep the number of slices small and avoid overlap.\n"
        "- Repeat shared constraints (time range, entity identifiers) in each relevant slice.\n"
        "- At most 3 slices.\n"
        "Expected JSON schema:\n"
        "{\n"
        '  "schema_version": "1",\n'
        '  "strategy": "single"|"multi",\n'
        '  "selected_sources": ["agent_id", ...],\n'
        '  "slices": [\n'
        "    {\n"
        '      "id": "s1",\n'
        '      "source_id": "agent_id",\n'
        '      "instructions": "string",\n'
        '      "carry_over_context": {},\n'
        '      "depends_on": []\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def build_routing_planner_instructions(deps: PlannerDeps) -> str:
    """Full instruction string for the model (dynamic per tenant capabilities)."""
    return (
        routing_planner_rules_and_schema_section()
        + "\n\nAvailable agents (JSON):\n"
        + deps.capabilities_json
        + "\n\nThe messages in the history after this instruction are the recent "
        "slice of conversation between user and assistant "
        f"(at most {PLANNER_RECENT_USER_TURNS} user-initiated turns)."
    )


def _create_routing_planner_agent(openai_model: OpenAIModel) -> Agent:
    """Wire up the agent with dynamic instructions via :class:`PlannerDeps`."""
    agent = Agent(
        openai_model,
        deps_type=PlannerDeps,
        output_type=PromptedOutput(RoutingPlan),
        model_settings=ModelSettings(temperature=0),
    )

    @agent.instructions
    def _routing_planner_instructions(ctx: RunContext[PlannerDeps]) -> str:
        return build_routing_planner_instructions(ctx.deps)

    return agent
