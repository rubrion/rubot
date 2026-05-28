from __future__ import annotations

from contextvars import ContextVar

trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)
tenant_id_var: ContextVar[str | None] = ContextVar("tenant_id", default=None)
chat_source_session_id_var: ContextVar[str | None] = ContextVar(
    "chat_source_session_id", default=None
)
sender_id_var: ContextVar[str | None] = ContextVar("sender_id", default=None)
