from __future__ import annotations

import logging
import traceback
from typing import Any

from rubot_logger.config import get_config
from rubot_logger.context import (
    chat_source_session_id_var,
    sender_id_var,
    tenant_id_var,
    trace_id_var,
)
from rubot_logger.envelope import ErrorDetail, LogEnvelope

_LEVEL_MAP = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARN": logging.WARNING,
    "ERROR": logging.ERROR,
}


class RubotLogger:
    def __init__(self, component: str) -> None:
        self._component = component
        self._stdlib = logging.getLogger(component)

    def _emit(
        self,
        level: str,
        event_type: str,
        message: str,
        *,
        error: Exception | None = None,
        agent: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        cfg = get_config()
        err_detail = None
        if error is not None:
            err_detail = ErrorDetail(
                type=type(error).__name__,
                message=str(error),
                stack=traceback.format_exc(),
            )

        envelope = LogEnvelope(
            log_level=level,
            service=cfg.service,
            component=self._component,
            environment=cfg.environment,
            deployment_hash=cfg.deployment_hash,
            tenant_id=tenant_id_var.get(),
            sender_id=sender_id_var.get(),
            chat_source_session_id=chat_source_session_id_var.get(),
            trace_id=trace_id_var.get(),
            event_type=event_type,
            message=message,
            error=err_detail,
            agent=agent,
            extra=extra or {},
        )

        self._stdlib.log(
            _LEVEL_MAP.get(level, logging.INFO),
            envelope.model_dump_json(exclude_none=True),
        )

    def debug(self, event_type: str, message: str, **kwargs: Any) -> None:
        self._emit("DEBUG", event_type, message, **kwargs)

    def info(self, event_type: str, message: str, **kwargs: Any) -> None:
        self._emit("INFO", event_type, message, **kwargs)

    def warn(self, event_type: str, message: str, **kwargs: Any) -> None:
        self._emit("WARN", event_type, message, **kwargs)

    def error(self, event_type: str, message: str, **kwargs: Any) -> None:
        self._emit("ERROR", event_type, message, **kwargs)


def get_logger(component: str) -> RubotLogger:
    return RubotLogger(component)
