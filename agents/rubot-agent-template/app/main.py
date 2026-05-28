"""FastAPI entrypoint for the rubot template agent.

Standard wire contract (do not change when forking):
  GET  /                       health check
  GET  /v1/capabilities        capabilities document for the router
  POST /v1/chat/completions    OpenAI-compatible completions endpoint

What's standard here (don't touch unless you have a reason):
  - RubotLoggingMiddleware (sets contextvars from headers, logs req/res)
  - rubot_logger.configure() at startup
  - Auth via ORCHESTRATOR_API_KEY
  - Header extraction: X-Tenant-Id + X-Rubot-Data-Bearer

What to customise per agent:
  - _CAPABILITIES (source_id + summary — used for routing)
  - service name in configure()
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime

from rubot_logger import configure as configure_logger
from rubot_logger import get_logger
from rubot_logger.middleware import RubotLoggingMiddleware
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from app.agent.runner import run_agent
from app.config import settings
from app.models import (
    AgentCapabilities,
    ChatChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    TokenUsage,
)

# TODO when forking: change "rubot-agent-template" to your service name.
# Reads RUBOT_SERVICE_NAME / RUBOT_ENVIRONMENT / RUBOT_DEPLOYMENT_HASH
# from env when not passed explicitly.
configure_logger(service="rubot-agent-template")
logger = get_logger(__name__)

app = FastAPI(
    title=settings.api_title,
    description=settings.api_description,
    version=settings.api_version,
)

# Order matters: logging middleware first, then CORS.
app.add_middleware(RubotLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# TODO when forking: rewrite source_id + summary. The router reads these
# to decide whether to call this agent. Be precise about what data this
# agent can answer about.
_CAPABILITIES = AgentCapabilities(
    source_id="template",
    name="Rubot Agent Template",
    summary=(
        "SCAFFOLD ONLY — replace this summary with a precise description of "
        "what your agent answers. The orchestrator routes by matching the "
        "user's question against this text."
    ),
)


@app.get("/")
async def health_check():
    return {
        "status": "ok",
        "service": settings.api_title,
        "version": settings.api_version,
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/v1/capabilities", response_model=AgentCapabilities)
async def get_capabilities(
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
):
    if not x_tenant_id:
        raise HTTPException(status_code=400, detail="Missing X-Tenant-Id header")
    logger.info("capabilities.requested", "capabilities document served")
    return _CAPABILITIES


@app.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def chat_completions(body: ChatCompletionRequest, request: Request):
    # Auth (only enforced when ORCHESTRATOR_API_KEY is set — lets you skip
    # it during local dev).
    if settings.ORCHESTRATOR_API_KEY:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {settings.ORCHESTRATOR_API_KEY}":
            raise HTTPException(status_code=401, detail="Invalid API key")

    tenant_id = request.headers.get("X-Tenant-Id", "")
    data_bearer = request.headers.get("X-Rubot-Data-Bearer", "")

    if not tenant_id:
        raise HTTPException(status_code=400, detail="Missing X-Tenant-Id header")
    if not data_bearer and settings.RUBOT_DATA_AUTH != "open":
        raise HTTPException(
            status_code=400, detail="Missing X-Rubot-Data-Bearer header"
        )

    messages = [m.model_dump(exclude_none=True) for m in body.messages]
    logger.info(
        "agent.run.started",
        "chat completion request received",
        extra={"tenant_id": tenant_id, "messages": len(messages)},
    )

    try:
        result = await run_agent(messages, tenant_id, data_bearer)
    except Exception as exc:
        logger.error(
            "agent.run.failed",
            "agent execution raised",
            error=exc,
            extra={"tenant_id": tenant_id},
        )
        raise HTTPException(status_code=500, detail="Agent execution failed")

    assistant_content = (result.content or "").strip()
    if not assistant_content:
        assistant_content = (
            "I could not complete your request right now. "
            "Please try again in a moment."
        )

    logger.info(
        "agent.run.completed",
        "chat completion ok",
        extra={"tenant_id": tenant_id, "len": len(assistant_content)},
    )

    return ChatCompletionResponse(
        id=f"chatcmpl-{uuid.uuid4().hex[:12]}",
        created=int(time.time()),
        model="template",
        choices=[
            ChatChoice(
                index=0,
                message=ChatMessage(role="assistant", content=assistant_content),
                finish_reason="stop",
            )
        ],
        usage=TokenUsage(prompt_tokens=0, completion_tokens=0, total_tokens=0),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
