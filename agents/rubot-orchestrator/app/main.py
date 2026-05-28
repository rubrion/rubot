from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from rubot_logger import configure as configure_logger
from rubot_logger import get_logger
from rubot_logger.middleware import RubotLoggingMiddleware

from app.config import settings
from app.models import ChatCompletionRequest
from app.router import route

configure_logger(service="rubot-orchestrator")
logger = get_logger(__name__)

app = FastAPI(
    title=settings.api_title,
    description=settings.api_description,
    version=settings.api_version,
)

app.add_middleware(RubotLoggingMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def health_check():
    return {
        "status": "ok",
        "service": settings.api_title,
        "version": settings.api_version,
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/v1/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    request: Request,
):
    if settings.GATEWAY_API_KEY:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {settings.GATEWAY_API_KEY}":
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
    last_msg = (messages[-1].get("content") or "")[:120] if messages else ""
    logger.info(
        "request.received",
        f"chat.completions msgs={len(messages)}",
        extra={
            "msg_count": len(messages),
            "last_message_preview": last_msg,
        },
    )

    try:
        response_data = await route(messages, tenant_id, data_bearer)
    except Exception as exc:
        logger.error(
            "routing.failed",
            f"routing failed for tenant_id={tenant_id}",
            error=exc,
        )
        raise HTTPException(status_code=502, detail="Specialist agent unavailable")

    return response_data


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
