"""Agent configuration: YAML loading, env-override merging, ModelSettings building.

Public API
----------
- ``load_agent_config(agent_name)`` — returns a fully-resolved ``AgentConfig``
- ``AgentConfig`` — Pydantic model with helpers for Pydantic AI integration
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, cast

import yaml
from pydantic import BaseModel, Field
from pydantic_ai.settings import ModelSettings

logger = logging.getLogger(__name__)

_DEFAULT_YAML_PATH = Path(__file__).parent / "agents.yaml"

_STANDARD_PARAMS: frozenset[str] = frozenset(
    {
        "max_tokens",
        "temperature",
        "top_p",
        "timeout",
        "parallel_tool_calls",
        "seed",
        "presence_penalty",
        "frequency_penalty",
        "logit_bias",
        "stop_sequences",
        "extra_headers",
        "thinking",
        "extra_body",
    }
)

_AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _env_prefix(agent_name: str) -> str:
    """Normalize agent name for env-var prefix: upper-case + hyphen→underscore."""
    return f"AGENT_{agent_name.upper().replace('-', '_')}_"


class AgentConfig(BaseModel):
    """Resolved configuration for a single rubot agent."""

    provider: str
    model: str
    base_url: str | None = None
    api_key_env: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)

    @property
    def model_id(self) -> str:
        """Pydantic AI model identifier string, e.g. ``'openai:gpt-4o-mini'``."""
        return f"{self.provider}:{self.model}"

    @property
    def model_settings(self) -> ModelSettings:
        """Build a ``ModelSettings`` dict from the resolved params.

        Standard fields pass through directly.  Non-standard fields are
        auto-prefixed with ``{provider}_`` following Pydantic AI convention
        (e.g. ``reasoning_effort`` → ``openai_reasoning_effort``).
        """
        return _build_model_settings(self.provider, self.params)

    def build_model(self) -> Any:
        """Return either a model ID string or an explicit Model object."""
        if not self.base_url and not self.api_key_env:
            return self.model_id

        api_key: str | None = None
        if self.api_key_env:
            api_key = os.environ.get(self.api_key_env)
            if not api_key:
                raise RuntimeError(
                    f"api_key_env='{self.api_key_env}' configured for "
                    f"provider '{self.provider}' but the env var is unset or empty"
                )

        return _build_provider_model(
            provider=self.provider,
            model_name=self.model,
            base_url=self.base_url,
            api_key=api_key,
        )


def load_agent_config(
    agent_name: str,
    *,
    config_path: Path | str | None = None,
) -> AgentConfig:
    """Load and resolve configuration for *agent_name*.

    Merge order (last wins):
      1. ``defaults`` section in the YAML
      2. per-agent section in the YAML
      3. environment variables matching ``AGENT_{NAME}_{PARAM}``

    ``config_path`` overrides the bundled ``agents.yaml``.  Can also be set
    via the ``RUBOT_CONFIG_PATH`` env var.
    """
    if not _AGENT_NAME_RE.match(agent_name):
        raise ValueError(
            f"Invalid agent_name '{agent_name}': must match [A-Za-z0-9_-]+"
        )

    raw = _load_yaml(config_path)
    defaults = dict(raw.get("defaults") or {})
    agents = raw.get("agents") or {}

    if agent_name in agents:
        agent_raw = dict(agents[agent_name])
    else:
        logger.warning(
            "Agent '%s' not listed in YAML; booting from defaults block. "
            "Available agents: %s",
            agent_name,
            ", ".join(sorted(agents.keys())) or "(none)",
        )
        agent_raw = {}

    merged: dict[str, Any] = {**defaults, **agent_raw}

    prefix = _env_prefix(agent_name)
    for env_key in os.environ:
        if env_key.startswith(prefix):
            param = env_key[len(prefix):].lower()
            merged[param] = _coerce_env_value(os.environ[env_key])

    provider = merged.pop("provider", None)
    model = merged.pop("model", None)
    base_url = merged.pop("base_url", None)
    api_key_env = merged.pop("api_key_env", None)

    if not provider:
        raise ValueError(f"Agent '{agent_name}': 'provider' is required")
    if not model:
        raise ValueError(f"Agent '{agent_name}': 'model' is required")

    params = {k: v for k, v in merged.items() if v is not None}

    config = AgentConfig(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key_env=api_key_env,
        params=params,
    )

    logger.info(
        "Loaded config for '%s': %s  settings=%s",
        agent_name,
        config.model_id,
        dict(config.model_settings),
    )

    return config


def _build_model_settings(provider: str, params: dict[str, Any]) -> ModelSettings:
    result: dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        if key in _STANDARD_PARAMS:
            result[key] = value
        else:
            result[f"{provider}_{key}"] = value
    return cast(ModelSettings, result)


def _build_provider_model(
    *,
    provider: str,
    model_name: str,
    base_url: str | None,
    api_key: str | None,
) -> Any:
    """Construct a provider-specific Model object for custom base_url / api_key."""
    provider_kwargs: dict[str, Any] = {}
    if base_url:
        provider_kwargs["base_url"] = base_url
    if api_key:
        provider_kwargs["api_key"] = api_key

    if provider == "openai":
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        return OpenAIChatModel(model_name, provider=OpenAIProvider(**provider_kwargs))

    if provider == "anthropic":
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        return AnthropicModel(model_name, provider=AnthropicProvider(**provider_kwargs))

    if provider == "groq":
        from pydantic_ai.models.groq import GroqModel
        from pydantic_ai.providers.groq import GroqProvider

        return GroqModel(model_name, provider=GroqProvider(**provider_kwargs))

    if provider == "mistral":
        from pydantic_ai.models.mistral import MistralModel
        from pydantic_ai.providers.mistral import MistralProvider

        return MistralModel(model_name, provider=MistralProvider(**provider_kwargs))

    logger.warning(
        "Provider '%s' has no explicit Model class mapping; "
        "falling back to model string (base_url/api_key_env will be ignored)",
        provider,
    )
    return f"{provider}:{model_name}"


def _coerce_env_value(raw: str) -> Any:
    """Best-effort coercion of an env-var string to a Python value."""
    stripped = raw.strip()
    if stripped.startswith(("{", "[")):
        try:
            return json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            pass

    if stripped.lower() in ("true", "false"):
        return stripped.lower() == "true"

    try:
        return int(stripped)
    except ValueError:
        pass
    try:
        return float(stripped)
    except ValueError:
        pass

    return raw


def _load_yaml(config_path: Path | str | None = None) -> dict[str, Any]:
    resolved = Path(
        config_path
        or os.environ.get("RUBOT_CONFIG_PATH")
        or _DEFAULT_YAML_PATH
    )
    if not resolved.exists():
        raise FileNotFoundError(
            f"Agent config file not found: {resolved}"
        )
    with open(resolved, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Expected a YAML mapping at top level in {resolved}")
    return data
