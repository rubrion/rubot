"""Build and emit an AgentLogPayload from a Pydantic AI RunResult.

This is the bridge between Pydantic AI's runtime data and the agent log
schema. Called automatically by ``BaseAgent.run()`` — individual agents
do not need to call this directly.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
)

from rubot_config.agent_log import (
    AgentLogPayload,
    Conversation,
    Dimensions,
    Execution,
    ModelStep,
    ProblemSignals,
    Step,
    ToolCallError,
    ToolStep,
)

logger = logging.getLogger(__name__)


def _extract_system_prompt(messages: list) -> str:
    for msg in messages:
        if not isinstance(msg, ModelRequest):
            continue
        for part in msg.parts:
            part_kind = getattr(part, "part_kind", None)
            if part_kind == "system-prompt":
                return getattr(part, "content", "")
    return ""


def _serialize_history(messages: list) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for msg in messages:
        if isinstance(msg, ModelRequest):
            for part in msg.parts:
                pk = getattr(part, "part_kind", "")
                if pk == "user-prompt":
                    result.append({"role": "user", "content": getattr(part, "content", "")})
        elif isinstance(msg, ModelResponse):
            text_parts = [
                getattr(p, "content", "")
                for p in msg.parts
                if getattr(p, "part_kind", "") == "text"
            ]
            if text_parts:
                result.append({"role": "assistant", "content": " ".join(text_parts)})
    return result


def _build_steps(messages: list) -> tuple[list[Step], list[ToolCallError]]:
    steps: list[Step] = []
    errors: list[ToolCallError] = []
    step_index = 0

    tool_return_map: dict[str, ToolReturnPart] = {}
    for msg in messages:
        if not isinstance(msg, ModelRequest):
            continue
        for part in msg.parts:
            if isinstance(part, ToolReturnPart):
                tool_return_map[part.tool_call_id] = part

    for msg in messages:
        if isinstance(msg, ModelResponse):
            model_step = ModelStep(
                step_index=step_index,
                model=msg.model_name,
                started_at=None,
                ended_at=getattr(msg, "timestamp", None),
                input_tokens=msg.usage.input_tokens if msg.usage else 0,
                output_tokens=msg.usage.output_tokens if msg.usage else 0,
                finish_reason=getattr(msg, "finish_reason", None),
            )
            steps.append(model_step)
            step_index += 1

            for part in msg.parts:
                if isinstance(part, ToolCallPart):
                    args = part.args
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except (ValueError, TypeError):
                            args = {"raw": args}
                    elif args is None:
                        args = {}

                    ret = tool_return_map.get(part.tool_call_id)
                    outcome = getattr(ret, "outcome", "success") if ret else "success"

                    status = "ok" if outcome == "success" else "error"

                    tool_step = ToolStep(
                        step_index=step_index,
                        tool_name=part.tool_name,
                        params=args if isinstance(args, dict) else {},
                        started_at=getattr(msg, "timestamp", None),
                        ended_at=getattr(ret, "timestamp", None) if ret else None,
                        status=status,
                        error=str(getattr(ret, "content", "")) if outcome != "success" else None,
                    )
                    steps.append(tool_step)

                    if outcome != "success":
                        errors.append(ToolCallError(
                            step_index=step_index,
                            tool_name=part.tool_name,
                            error_type=outcome,
                            message=str(getattr(ret, "content", ""))[:500],
                        ))

                    step_index += 1

    return steps, errors


def build_agent_log(
    *,
    result: Any,
    agent_type: str,
    model_provider: str,
    model_name: str,
    user_prompt: str,
    started_at: datetime,
    ended_at: datetime,
    data_source: str | None = None,
    methodology_used: str | None = None,
    methodology_version: str | None = None,
    is_test: bool = False,
    routine_id: str | None = None,
) -> AgentLogPayload:
    """Build an ``AgentLogPayload`` from a Pydantic AI ``RunResult``."""
    all_messages = result.all_messages()
    new_messages = result.new_messages()

    steps, tool_errors = _build_steps(new_messages)

    system_prompt = _extract_system_prompt(all_messages)
    history = _serialize_history(all_messages)

    assistant_response = ""
    output = getattr(result, "output", None)
    if output is None:
        output = getattr(result, "data", None)
    if output is not None:
        assistant_response = str(output)

    return AgentLogPayload(
        dimensions=Dimensions(
            agent_type=agent_type,
            data_source=data_source,
            model_provider=model_provider,
            model_name=model_name,
            methodology_used=methodology_used,
            methodology_version=methodology_version,
            is_test=is_test,
            routine_id=routine_id,
        ),
        conversation=Conversation(
            user_message=user_prompt,
            assistant_response=assistant_response,
            system_prompt_snapshot=system_prompt,
            message_history=history,
        ),
        execution=Execution(
            started_at=started_at,
            ended_at=ended_at,
            steps=steps,
        ),
        problem_signals=ProblemSignals(
            tool_call_errors=tool_errors,
        ),
    )


def emit_agent_log(payload: AgentLogPayload) -> None:
    """Emit the agent log as a structured JSON line.

    If ``rubot-logger`` is installed, wraps the payload in the standard
    log envelope with context (trace_id, tenant_id, etc.). Falls back to
    a plain JSON line when the package is not available.
    """
    try:
        from rubot_logger import get_logger as _get_structured_logger

        rlog = _get_structured_logger(__name__)
        rlog.info(
            "agent.log",
            "Agent execution completed",
            agent=payload.model_dump(by_alias=True),
        )
    except ImportError:
        logger.info("agent_log | %s", payload.model_dump_json(by_alias=True))
