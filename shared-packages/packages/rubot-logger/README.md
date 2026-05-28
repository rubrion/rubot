# rubot-logger

Structured JSON envelope + context propagation for rubot Python services.

Every log line is a single JSON object with:
- service identity (`service`, `environment`, `deployment_hash`)
- request context pulled from contextvars (`trace_id`, `tenant_id`, `chat_source_session_id`, `sender_id`)
- event metadata (`event_type`, `message`, optional `error`, `extra`, `agent`)

## Quick start

```python
from rubot_logger import configure, get_logger
from rubot_logger.middleware import RubotLoggingMiddleware

# Once at startup. Reads RUBOT_SERVICE_NAME / RUBOT_ENVIRONMENT / RUBOT_DEPLOYMENT_HASH
# when not passed explicitly.
configure(service="my-agent")
log = get_logger(__name__)

# FastAPI
app.add_middleware(RubotLoggingMiddleware)

# Log events
log.info("agent.run.started", "user prompt received", extra={"prompt_len": 42})
log.error("upstream.timeout", "data service did not respond", error=exc)
```

## Headers it reads (and sets on responses)

| Header | Maps to contextvar |
|---|---|
| `X-Rubot-Trace-Id` (also reads `traceparent`) | `trace_id_var` |
| `X-Tenant-Id` | `tenant_id_var` |
| `X-Chat-Source-Session-Id` | `chat_source_session_id_var` |
| `X-Chat-Source-Sender-Id` | `sender_id_var` |

The middleware mints a 32-char hex `trace_id` if neither header is present,
sets the contextvars for the request scope, and writes `X-Rubot-Trace-Id`
on the outbound response.

## Local testing

```bash
pip install -e '.[fastapi,dev]'
pytest
```
