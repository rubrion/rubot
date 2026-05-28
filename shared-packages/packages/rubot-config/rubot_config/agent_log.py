from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


# ── Dimensions ───────────────────────────────────────────────────────
# Agent-specific identity fields. Envelope already carries tenant_id,
# trace_id, service, timestamp — do not repeat them.


class Dimensions(BaseModel):
    agent_type: str
    data_source: Optional[str] = None
    model_provider: str
    model_name: str
    methodology_used: Optional[str] = None
    methodology_version: Optional[str] = None
    is_test: bool = False
    routine_id: Optional[str] = None


# ── Conversation ─────────────────────────────────────────────────────


class Conversation(BaseModel):
    user_message: str
    assistant_response: str
    system_prompt_snapshot: str
    message_history: list[dict[str, Any]]
    session_summary: Optional[str] = None
    injected_memories: list[dict[str, Any]] = Field(default_factory=list)


# ── Execution steps ──────────────────────────────────────────────────


class ModelStep(BaseModel):
    """One LLM request → response round-trip."""

    kind: Literal["model_request"] = "model_request"
    step_index: int
    model: Optional[str] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: Optional[float] = None
    finish_reason: Optional[str] = None
    error: Optional[str] = None


class ToolStep(BaseModel):
    """One tool invocation (data-fetch, computation, etc.)."""

    kind: Literal["tool_call"] = "tool_call"
    step_index: int
    tool_name: str
    params: dict[str, Any] = Field(default_factory=dict)
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    status: Literal["ok", "error", "timeout"] = "ok"
    data_source_response_ref: Optional[str] = None
    error: Optional[str] = None


Step = Annotated[
    Union[ModelStep, ToolStep],
    Field(discriminator="kind"),
]


class Execution(BaseModel):
    started_at: datetime
    ended_at: datetime
    steps: list[Step]


# ── Problem signals ──────────────────────────────────────────────────


class ToolCallError(BaseModel):
    step_index: int
    tool_name: str
    error_type: str
    message: str


class ProblemSignals(BaseModel):
    tool_call_errors: list[ToolCallError] = Field(default_factory=list)
    context_overflow_triggered: bool = False
    compaction_triggered: bool = False
    compaction_turns_removed: Optional[int] = None


# ── Top-level agent payload ──────────────────────────────────────────


class AgentLogPayload(BaseModel):
    """The ``"agent"`` object inside the rubot log envelope.

    Serialise with ``model_dump(by_alias=True)`` to produce the JSON key
    ``"_schema"`` expected by the envelope contract.
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_id: Literal["agent_log_v1"] = Field(
        default="agent_log_v1",
        alias="_schema",
    )
    dimensions: Dimensions
    conversation: Conversation
    execution: Execution
    problem_signals: ProblemSignals = Field(default_factory=ProblemSignals)
    evaluation: Optional[dict[str, Any]] = None
    triage: Optional[dict[str, Any]] = None
