from __future__ import annotations

import secrets
import time
from typing import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from rubot_logger.context import (
    chat_source_session_id_var,
    sender_id_var,
    tenant_id_var,
    trace_id_var,
)
from rubot_logger.logger import get_logger

_logger = get_logger("rubot_logger.middleware")

TRACE_HEADER = "x-rubot-trace-id"
TRACEPARENT_HEADER = "traceparent"
TENANT_HEADER = "x-tenant-id"
SESSION_HEADER = "x-chat-source-session-id"
SENDER_HEADER = "x-chat-source-sender-id"


def _extract_trace_id(request: Request) -> str | None:
    trace = request.headers.get(TRACE_HEADER)
    if trace and len(trace) == 32:
        return trace
    tp = request.headers.get(TRACEPARENT_HEADER)
    if tp:
        parts = tp.split("-")
        if len(parts) >= 2 and len(parts[1]) == 32:
            return parts[1]
    return None


def _generate_trace_id() -> str:
    return secrets.token_hex(16)


class RubotLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        trace_id = _extract_trace_id(request) or _generate_trace_id()
        tenant_id = request.headers.get(TENANT_HEADER)
        session_id = request.headers.get(SESSION_HEADER)
        sender_id = request.headers.get(SENDER_HEADER)

        t1 = trace_id_var.set(trace_id)
        t2 = tenant_id_var.set(tenant_id)
        t3 = chat_source_session_id_var.set(session_id)
        t4 = sender_id_var.set(sender_id)

        start = time.monotonic()
        try:
            _logger.info(
                "http.request.received",
                f"{request.method} {request.url.path}",
            )
            response = await call_next(request)
            elapsed_ms = (time.monotonic() - start) * 1000
            _logger.info(
                "http.request.completed",
                f"{request.method} {request.url.path} -> {response.status_code}",
                extra={"elapsed_ms": round(elapsed_ms, 1), "status_code": response.status_code},
            )
            response.headers[TRACE_HEADER] = trace_id
            return response
        except Exception as exc:
            elapsed_ms = (time.monotonic() - start) * 1000
            _logger.error(
                "http.request.failed",
                f"{request.method} {request.url.path} failed",
                error=exc,
                extra={"elapsed_ms": round(elapsed_ms, 1)},
            )
            raise
        finally:
            trace_id_var.reset(t1)
            tenant_id_var.reset(t2)
            chat_source_session_id_var.reset(t3)
            sender_id_var.reset(t4)
