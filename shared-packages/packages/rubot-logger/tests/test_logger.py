from __future__ import annotations

import json
import logging

from rubot_logger.config import configure
from rubot_logger.context import tenant_id_var, trace_id_var
from rubot_logger.logger import get_logger


def test_logger_emits_json_envelope(caplog):
    configure(service="test-svc", environment="test", deployment_hash="abc123")
    logger = get_logger("test.component")

    with caplog.at_level(logging.INFO, logger="test.component"):
        logger.info("http.request.received", "GET /health")

    assert len(caplog.records) == 1
    data = json.loads(caplog.records[0].message)
    assert data["service"] == "test-svc"
    assert data["component"] == "test.component"
    assert data["event_type"] == "http.request.received"
    assert data["message"] == "GET /health"
    assert data["environment"] == "test"
    assert data["log_level"] == "INFO"


def test_logger_includes_context_vars(caplog):
    configure(service="test-svc", environment="test", deployment_hash="")
    logger = get_logger("test.ctx")

    t1 = trace_id_var.set("a" * 32)
    t2 = tenant_id_var.set("tenant-01")
    try:
        with caplog.at_level(logging.INFO, logger="test.ctx"):
            logger.info("agent.run.completed", "Done")
        data = json.loads(caplog.records[0].message)
        assert data["trace_id"] == "a" * 32
        assert data["tenant_id"] == "tenant-01"
    finally:
        trace_id_var.reset(t1)
        tenant_id_var.reset(t2)


def test_logger_includes_error_detail(caplog):
    configure(service="test-svc", environment="test", deployment_hash="")
    logger = get_logger("test.err")

    try:
        raise ValueError("bad input")
    except ValueError as exc:
        with caplog.at_level(logging.ERROR, logger="test.err"):
            logger.error("tool.call.failed", "Tool failed", error=exc)

    data = json.loads(caplog.records[0].message)
    assert data["error"]["type"] == "ValueError"
    assert data["error"]["message"] == "bad input"


def test_logger_includes_agent_payload(caplog):
    configure(service="test-svc", environment="test", deployment_hash="")
    logger = get_logger("test.agent")

    agent_payload = {"_schema": "agent_log_v1", "dimensions": {"agent_type": "template"}}

    with caplog.at_level(logging.INFO, logger="test.agent"):
        logger.info("agent.log", "Agent done", agent=agent_payload)

    data = json.loads(caplog.records[0].message)
    assert data["agent"]["_schema"] == "agent_log_v1"


def test_logger_extra_field(caplog):
    configure(service="test-svc", environment="test", deployment_hash="")
    logger = get_logger("test.extra")

    with caplog.at_level(logging.INFO, logger="test.extra"):
        logger.info("data.fetch.completed", "Fetched rows", extra={"rows": 42})

    data = json.loads(caplog.records[0].message)
    assert data["extra"]["rows"] == 42
