"""Tests for rubot_config.config — YAML loading, merging, and ModelSettings building."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from rubot_config.config import (
    AgentConfig,
    _build_model_settings,
    _coerce_env_value,
    _env_prefix,
    load_agent_config,
)


@pytest.fixture()
def tmp_yaml(tmp_path: Path) -> Path:
    p = tmp_path / "agents.yaml"
    p.write_text(
        textwrap.dedent("""\
        defaults:
          temperature: 0.3
          max_tokens: 4096

        agents:
          alpha:
            provider: openai
            model: gpt-4o-mini
            temperature: 0.1

          beta:
            provider: anthropic
            model: claude-sonnet-4-5
            max_tokens: 2000

          custom_url:
            provider: openai
            model: my-model
            base_url: https://my-proxy.example.com/v1
            api_key_env: MY_CUSTOM_KEY

          with_extras:
            provider: openai
            model: gpt-5.1
            max_tokens: 6500
            reasoning_effort: high

          hyphen-agent:
            provider: openai
            model: gpt-4o
        """),
        encoding="utf-8",
    )
    return p


@pytest.fixture()
def tmp_yaml_with_provider_defaults(tmp_path: Path) -> Path:
    p = tmp_path / "agents.yaml"
    p.write_text(
        textwrap.dedent("""\
        defaults:
          provider: openai
          model: gpt-4o-mini
          timeout: 30.0

        agents:
          known:
            provider: anthropic
            model: claude-sonnet-4-5
        """),
        encoding="utf-8",
    )
    return p


def test_loads_agent_with_defaults_merged(tmp_yaml: Path):
    cfg = load_agent_config("beta", config_path=tmp_yaml)

    assert cfg.provider == "anthropic"
    assert cfg.model == "claude-sonnet-4-5"
    assert cfg.model_id == "anthropic:claude-sonnet-4-5"
    assert cfg.params["max_tokens"] == 2000
    assert cfg.params["temperature"] == 0.3


def test_agent_specific_overrides_defaults(tmp_yaml: Path):
    cfg = load_agent_config("alpha", config_path=tmp_yaml)

    assert cfg.params["temperature"] == 0.1
    assert cfg.params["max_tokens"] == 4096


def test_env_override_takes_precedence(tmp_yaml: Path, monkeypatch):
    monkeypatch.setenv("AGENT_ALPHA_MODEL", "gpt-4o")
    monkeypatch.setenv("AGENT_ALPHA_TEMPERATURE", "0.9")

    cfg = load_agent_config("alpha", config_path=tmp_yaml)

    assert cfg.model == "gpt-4o"
    assert cfg.params["temperature"] == 0.9


def test_env_override_provider(tmp_yaml: Path, monkeypatch):
    monkeypatch.setenv("AGENT_BETA_PROVIDER", "openai")
    monkeypatch.setenv("AGENT_BETA_MODEL", "gpt-4o-mini")

    cfg = load_agent_config("beta", config_path=tmp_yaml)

    assert cfg.provider == "openai"
    assert cfg.model == "gpt-4o-mini"
    assert cfg.model_id == "openai:gpt-4o-mini"


def test_hyphenated_name_normalizes_env_prefix(tmp_yaml: Path, monkeypatch):
    monkeypatch.setenv("AGENT_HYPHEN_AGENT_MODEL", "gpt-4o-mini")

    cfg = load_agent_config("hyphen-agent", config_path=tmp_yaml)

    assert cfg.model == "gpt-4o-mini"


def test_unknown_agent_falls_back_to_defaults(
    tmp_yaml_with_provider_defaults: Path, caplog
):
    with caplog.at_level("WARNING"):
        cfg = load_agent_config("brand-new", config_path=tmp_yaml_with_provider_defaults)

    assert cfg.provider == "openai"
    assert cfg.model == "gpt-4o-mini"
    assert cfg.params["timeout"] == 30.0
    assert any("brand-new" in rec.message for rec in caplog.records)


def test_unknown_agent_with_empty_defaults_raises(tmp_path: Path):
    p = tmp_path / "bad.yaml"
    p.write_text("defaults: {}\nagents:\n  known:\n    provider: openai\n    model: gpt-4o\n", encoding="utf-8")

    with pytest.raises(ValueError, match="provider"):
        load_agent_config("missing", config_path=p)


def test_invalid_agent_name_raises(tmp_yaml: Path):
    with pytest.raises(ValueError, match="Invalid agent_name"):
        load_agent_config("not valid!", config_path=tmp_yaml)


def test_missing_provider_raises(tmp_path: Path):
    p = tmp_path / "bad.yaml"
    p.write_text("defaults: {}\nagents:\n  bad:\n    model: gpt-4o\n", encoding="utf-8")

    with pytest.raises(ValueError, match="provider"):
        load_agent_config("bad", config_path=p)


def test_missing_model_raises(tmp_path: Path):
    p = tmp_path / "bad.yaml"
    p.write_text("defaults: {}\nagents:\n  bad:\n    provider: openai\n", encoding="utf-8")

    with pytest.raises(ValueError, match="model"):
        load_agent_config("bad", config_path=p)


def test_base_url_and_api_key_env(tmp_yaml: Path):
    cfg = load_agent_config("custom_url", config_path=tmp_yaml)

    assert cfg.base_url == "https://my-proxy.example.com/v1"
    assert cfg.api_key_env == "MY_CUSTOM_KEY"


def test_config_path_env_var(tmp_yaml: Path, monkeypatch):
    monkeypatch.setenv("RUBOT_CONFIG_PATH", str(tmp_yaml))
    cfg = load_agent_config("alpha")

    assert cfg.provider == "openai"


def test_env_prefix_helper():
    assert _env_prefix("template") == "AGENT_TEMPLATE_"
    assert _env_prefix("my-agent") == "AGENT_MY_AGENT_"
    assert _env_prefix("Mixed-Case_Name") == "AGENT_MIXED_CASE_NAME_"


def test_standard_params_pass_through():
    ms = _build_model_settings("openai", {"temperature": 0.5, "max_tokens": 100})

    assert ms["temperature"] == 0.5
    assert ms["max_tokens"] == 100


def test_non_standard_params_get_provider_prefix():
    ms = _build_model_settings("openai", {"reasoning_effort": "high"})

    assert ms["openai_reasoning_effort"] == "high"
    assert "reasoning_effort" not in ms


def test_mixed_standard_and_extra():
    ms = _build_model_settings(
        "anthropic",
        {"temperature": 0.2, "max_tokens": 500, "custom_flag": True},
    )

    assert ms["temperature"] == 0.2
    assert ms["max_tokens"] == 500
    assert ms["anthropic_custom_flag"] is True


def test_none_values_skipped():
    ms = _build_model_settings("openai", {"temperature": None, "max_tokens": 100})

    assert "temperature" not in ms
    assert ms["max_tokens"] == 100


def test_empty_params_returns_empty():
    ms = _build_model_settings("openai", {})
    assert dict(ms) == {}


def test_agent_config_model_settings(tmp_yaml: Path):
    cfg = load_agent_config("with_extras", config_path=tmp_yaml)
    ms = cfg.model_settings

    assert ms["max_tokens"] == 6500
    assert ms["openai_reasoning_effort"] == "high"


def test_build_model_returns_string_by_default(tmp_yaml: Path):
    cfg = load_agent_config("alpha", config_path=tmp_yaml)
    model = cfg.build_model()

    assert model == "openai:gpt-4o-mini"


def test_build_model_returns_object_with_base_url(tmp_yaml: Path, monkeypatch):
    monkeypatch.setenv("MY_CUSTOM_KEY", "sk-test-key")
    cfg = load_agent_config("custom_url", config_path=tmp_yaml)
    model = cfg.build_model()

    assert not isinstance(model, str)
    assert "OpenAI" in type(model).__name__


def test_build_model_raises_when_api_key_env_unset(tmp_yaml: Path, monkeypatch):
    monkeypatch.delenv("MY_CUSTOM_KEY", raising=False)
    cfg = load_agent_config("custom_url", config_path=tmp_yaml)

    with pytest.raises(RuntimeError, match="MY_CUSTOM_KEY"):
        cfg.build_model()


def test_coerce_int():
    assert _coerce_env_value("42") == 42


def test_coerce_float():
    assert _coerce_env_value("0.7") == 0.7


def test_coerce_bool_true():
    assert _coerce_env_value("true") is True


def test_coerce_bool_false():
    assert _coerce_env_value("False") is False


def test_coerce_string():
    assert _coerce_env_value("gpt-4o") == "gpt-4o"


def test_coerce_json_dict():
    assert _coerce_env_value('{"a": 1}') == {"a": 1}


def test_coerce_json_list():
    assert _coerce_env_value('["stop", "end"]') == ["stop", "end"]


def test_agent_config_construct_directly():
    cfg = AgentConfig(provider="openai", model="gpt-4o-mini")
    assert cfg.params == {}
    assert cfg.model_id == "openai:gpt-4o-mini"
