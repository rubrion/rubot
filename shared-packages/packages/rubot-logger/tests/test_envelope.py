from __future__ import annotations

import json

from rubot_logger.envelope import ErrorDetail, LogEnvelope


def test_envelope_serializes_with_required_fields():
    env = LogEnvelope(
        log_level="INFO",
        service="test-svc",
        component="test.module",
        environment="dev",
        event_type="http.request.received",
        message="hello",
    )
    data = json.loads(env.model_dump_json(exclude_none=True))

    assert data["log_level"] == "INFO"
    assert data["service"] == "test-svc"
    assert data["event_type"] == "http.request.received"
    assert "timestamp" in data
    assert "tenant_id" not in data
    assert "agent" not in data


def test_envelope_includes_optional_fields_when_set():
    env = LogEnvelope(
        log_level="ERROR",
        service="svc",
        component="mod",
        environment="production",
        event_type="agent.log",
        message="done",
        tenant_id="tenant-01",
        trace_id="a" * 32,
        agent={"_schema": "agent_log_v1", "dimensions": {}},
    )
    data = json.loads(env.model_dump_json(exclude_none=True))

    assert data["tenant_id"] == "tenant-01"
    assert data["trace_id"] == "a" * 32
    assert data["agent"]["_schema"] == "agent_log_v1"


def test_error_detail_serializes():
    err = ErrorDetail(type="ValueError", message="bad input", stack="traceback...")
    data = err.model_dump()
    assert data["type"] == "ValueError"
    assert data["stack"] == "traceback..."


def test_envelope_extra_defaults_to_empty_dict():
    env = LogEnvelope(
        log_level="DEBUG",
        service="svc",
        component="mod",
        environment="dev",
        event_type="test",
        message="x",
    )
    assert env.extra == {}
