import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from rubot_logger import get_logger

logger = get_logger(__name__)

_DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.json"


def load_config(path: Path | str | None = None) -> dict:
    if path is None:
        path = os.environ.get("GUARDRAILS_CONFIG_PATH")
    p = Path(path) if path else _DEFAULT_CONFIG
    with open(p, encoding="utf-8") as f:
        return json.load(f)


@dataclass
class AgentOutput:
    content: str
    tokens: dict = field(default_factory=lambda: {"input": 0, "output": 0, "total": 0})


class GuardrailsPipeline:
    """Stateless guardrails wrapper: regex -> MLP -> agent -> output guardrail."""

    def __init__(self, config: dict, enabled: dict | None = None):
        self.config = config
        self.enabled = enabled or config["enabled"]
        self.block_messages = config["messages"]
        self.guards = self._init_guardrails()

    def _init_guardrails(self):
        guards: dict[str, Any] = {"regex": None, "mlp": None, "output": None}

        if self.enabled.get("regex"):
            from input.regex.guardrail import RegexGuardrail

            guards["regex"] = RegexGuardrail()

        if self.enabled.get("mlp"):
            from input.mlp.guardrail import InputGuardrail

            guards["mlp"] = InputGuardrail(
                threshold_block=self.config["mlp"]["threshold_block"],
                threshold_release=self.config["mlp"]["threshold_release"],
            )

        if self.enabled.get("output"):
            from output.guardrail import OutputGuardrail

            out_cfg = self.config["output"]
            guards["output"] = OutputGuardrail(
                pillars=out_cfg["pillars"],
                threshold_block=out_cfg["threshold_block"],
                threshold_review=out_cfg["threshold_review"],
                model=out_cfg.get("model"),
                temperature=out_cfg.get("temperature"),
            )

        return guards

    async def run(
        self,
        user_message: str,
        agent_fn: Callable[[], Awaitable[AgentOutput]],
    ) -> dict:
        """Run the full guardrails pipeline around *agent_fn*.

        *agent_fn* is an async **no-arg** callable that returns an
        :class:`AgentOutput`.  Callers should bind their agent-specific
        arguments via ``functools.partial`` or a closure.
        """
        result: dict[str, Any] = {
            "input_guardrails": {},
            "agent": None,
            "output_guardrail": None,
            "delivered_message": None,
            "blocked_by": None,
        }

        # -- regex ----------------------------------------------------------
        if self.guards["regex"]:
            t0 = time.perf_counter()
            regex_out = self.guards["regex"].evaluate(user_message)
            latency = (time.perf_counter() - t0) * 1000
            result["input_guardrails"]["regex"] = {
                "verdict": regex_out["verdict"],
                "matched": regex_out["matched"],
                "latency_ms": round(latency, 1),
            }
            if regex_out["verdict"] == "blocked":
                result["blocked_by"] = "regex"
                result["delivered_message"] = self.block_messages["blocked_regex"]
                return result

        # -- mlp ------------------------------------------------------------
        if self.guards["mlp"]:
            t0 = time.perf_counter()
            mlp_out = self.guards["mlp"].evaluate(user_message)
            latency = (time.perf_counter() - t0) * 1000
            result["input_guardrails"]["mlp"] = {
                "verdict": mlp_out["verdict"],
                "probabilities": mlp_out["probabilities"],
                "latency_ms": round(latency, 1),
            }
            if mlp_out["verdict"] == "blocked":
                result["blocked_by"] = "mlp"
                result["delivered_message"] = self.block_messages["blocked_mlp"]
                return result

        # -- agent ----------------------------------------------------------
        t0 = time.perf_counter()
        try:
            agent_out = await agent_fn()
            agent_latency = (time.perf_counter() - t0) * 1000
            agent_answer = agent_out.content
        except Exception as e:
            agent_latency = (time.perf_counter() - t0) * 1000
            logger.error("agent.error", f"Agent call failed: {e}")
            agent_answer = ""
            agent_out = AgentOutput(content="")

        if not agent_answer:
            agent_answer = (
                "I was unable to complete your request at this time. "
                "Please try again shortly."
            )

        result["agent"] = {
            "raw_response": agent_answer,
            "latency_ms": round(agent_latency, 1),
            "tokens": agent_out.tokens,
        }

        # -- output guardrail ----------------------------------------------
        if self.guards["output"]:
            t0 = time.perf_counter()
            try:
                output_out = await self.guards["output"].evaluate(
                    user_message, agent_answer,
                )
            except Exception as e:
                logger.error("output_guardrail.error", f"Output guardrail failed: {e}")
                output_out = {
                    "verdict": "error",
                    "max_score": 0,
                    "pillars": [],
                    "tokens": {"input": 0, "output": 0, "total": 0},
                }
            latency = (time.perf_counter() - t0) * 1000

            result["output_guardrail"] = {
                "verdict": output_out["verdict"],
                "max_score": output_out["max_score"],
                "pillars": [
                    {"pillar": p["pillar"], "score": p["score"]}
                    for p in output_out["pillars"]
                ],
                "latency_ms": round(latency, 1),
                "tokens": output_out.get(
                    "tokens", {"input": 0, "output": 0, "total": 0}
                ),
            }

            if output_out["verdict"] == "blocked":
                result["blocked_by"] = "output"
                result["delivered_message"] = self.block_messages["blocked_output"]
                return result

        result["delivered_message"] = agent_answer
        return result


# conversational wrapper


class ChatPipeline:
    """Wraps :class:`GuardrailsPipeline` with message-history management.

    Used by the terminal REPL and the agent simulator.

    *run_turn* signature::

        async def run_turn(message: str, history) -> tuple[AgentOutput, new_history]
    """

    def __init__(
        self,
        config: dict,
        run_turn: Callable[..., Awaitable[tuple[AgentOutput, Any]]],
        enabled: dict | None = None,
    ):
        self.guardrails = GuardrailsPipeline(config, enabled)
        self.run_turn = run_turn
        self.history: Any = None

    def reset(self):
        self.history = None

    async def invoke(self, message: str) -> dict:
        async def _agent_fn():
            output, new_history = await self.run_turn(message, self.history)
            self.history = new_history
            return output

        return await self.guardrails.run(message, _agent_fn)
