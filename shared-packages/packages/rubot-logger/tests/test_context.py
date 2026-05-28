from __future__ import annotations

from rubot_logger.context import (
    chat_source_session_id_var,
    sender_id_var,
    tenant_id_var,
    trace_id_var,
)


def test_context_vars_default_to_none():
    assert trace_id_var.get() is None
    assert tenant_id_var.get() is None
    assert chat_source_session_id_var.get() is None
    assert sender_id_var.get() is None


def test_context_vars_set_and_reset():
    token = trace_id_var.set("abc123")
    assert trace_id_var.get() == "abc123"
    trace_id_var.reset(token)
    assert trace_id_var.get() is None
