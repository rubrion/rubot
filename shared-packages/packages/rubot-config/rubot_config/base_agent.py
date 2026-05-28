from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, ClassVar

from pydantic_ai import Agent

from rubot_config.agent_log_emitter import build_agent_log, emit_agent_log
from rubot_config.config import AgentConfig, load_agent_config

logger = logging.getLogger(__name__)

_AGENT_REGISTRY: dict[str, type] = {}


class BaseAgent:
    """Base class for all rubot Pydantic AI agents.

    Subclass and set the ``agent_name`` class variable to match a key in
    ``agents.yaml`` (or rely on the ``defaults:`` block for unlisted names).
    LLM configuration is loaded automatically; the subclass only needs to
    register its domain-specific tools and prompts.
    """

    agent_name: ClassVar[str]

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        name = getattr(cls, "agent_name", None)
        if not name:
            return
        existing = _AGENT_REGISTRY.get(name)
        if existing is not None and existing is not cls:
            raise TypeError(
                f"Duplicate agent_name '{name}': already registered by "
                f"{existing.__module__}.{existing.__name__}, cannot also "
                f"register {cls.__module__}.{cls.__name__}"
            )
        _AGENT_REGISTRY[name] = cls

    def __init__(
        self,
        *,
        deps_type: type,
        output_type: type = str,
        **agent_kwargs: Any,
    ) -> None:
        if not getattr(self.__class__, "agent_name", None):
            raise TypeError(
                f"{self.__class__.__name__} must define an 'agent_name' class variable"
            )

        self.config: AgentConfig = load_agent_config(self.agent_name)

        model = self.config.build_model()

        self.agent: Agent = Agent(
            model,
            deps_type=deps_type,
            output_type=output_type,
            model_settings=self.config.model_settings,
            **agent_kwargs,
        )

        logger.info(
            "BaseAgent '%s' ready: %s | settings=%s",
            self.agent_name,
            self.config.model_id,
            dict(self.config.model_settings),
        )

    @property
    def tool(self):
        return self.agent.tool

    @property
    def tool_plain(self):
        return self.agent.tool_plain

    @property
    def system_prompt(self):
        return self.agent.system_prompt

    @property
    def instructions(self):
        return self.agent.instructions

    @property
    def result_validator(self):
        return self.agent.result_validator

    async def run(self, *args: Any, **kwargs: Any):
        started_at = datetime.now(timezone.utc)
        result = await self.agent.run(*args, **kwargs)
        ended_at = datetime.now(timezone.utc)

        try:
            user_prompt = args[0] if args else kwargs.get("user_prompt", "")
            payload = build_agent_log(
                result=result,
                agent_type=self.agent_name,
                model_provider=self.config.provider,
                model_name=self.config.model,
                user_prompt=str(user_prompt),
                started_at=started_at,
                ended_at=ended_at,
            )
            emit_agent_log(payload)
        except Exception:
            logger.warning("failed to emit agent log", exc_info=True)

        return result

    @asynccontextmanager
    async def run_stream(self, *args: Any, **kwargs: Any):
        started_at = datetime.now(timezone.utc)
        async with self.agent.run_stream(*args, **kwargs) as result:
            yield result
        ended_at = datetime.now(timezone.utc)

        try:
            user_prompt = args[0] if args else kwargs.get("user_prompt", "")
            payload = build_agent_log(
                result=result,
                agent_type=self.agent_name,
                model_provider=self.config.provider,
                model_name=self.config.model,
                user_prompt=str(user_prompt),
                started_at=started_at,
                ended_at=ended_at,
            )
            emit_agent_log(payload)
        except Exception:
            logger.warning("failed to emit agent log (stream)", exc_info=True)

    def run_sync(self, *args: Any, **kwargs: Any):
        started_at = datetime.now(timezone.utc)
        result = self.agent.run_sync(*args, **kwargs)
        ended_at = datetime.now(timezone.utc)

        try:
            user_prompt = args[0] if args else kwargs.get("user_prompt", "")
            payload = build_agent_log(
                result=result,
                agent_type=self.agent_name,
                model_provider=self.config.provider,
                model_name=self.config.model,
                user_prompt=str(user_prompt),
                started_at=started_at,
                ended_at=ended_at,
            )
            emit_agent_log(payload)
        except Exception:
            logger.warning("failed to emit agent log (sync)", exc_info=True)

        return result

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} "
            f"agent_name={self.agent_name!r} "
            f"model={self.config.model_id!r}>"
        )
