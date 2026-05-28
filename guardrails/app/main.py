import time
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from rubot_logger import configure as configure_logger, get_logger
from rubot_logger.middleware import RubotLoggingMiddleware

from app.config import settings
from pipeline import AgentOutput, GuardrailsPipeline, load_config

configure_logger(service="rubot-guardrails")
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

_pipeline: GuardrailsPipeline | None = None


def _get_pipeline() -> GuardrailsPipeline:
    global _pipeline
    if _pipeline is None:
        cfg = load_config()
        _pipeline = GuardrailsPipeline(cfg)
    return _pipeline


def _openai_envelope(content: str) -> dict:
    now = int(time.time())
    return {
        "id": f"chatcmpl-guardrails-{now}",
        "object": "chat.completion",
        "created": now,
        "model": "guardrails",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _extract_last_user_message(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return " ".join(
                    part.get("text", "") for part in content if isinstance(part, dict)
                )
    return ""


async def _call_orchestrator(
    body: dict,
    tenant_id: str,
    data_bearer: str,
) -> dict:
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.GATEWAY_API_KEY}",
        "X-Tenant-Id": tenant_id,
    }
    if data_bearer:
        headers["X-Rubot-Data-Bearer"] = data_bearer

    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            f"{settings.ORCHESTRATOR_URL}/v1/chat/completions",
            json=body,
            headers=headers,
        )
        if resp.status_code >= 400:
            logger.error(
                "orchestrator.error",
                f"status={resp.status_code} body={resp.text[:500]}",
            )
        resp.raise_for_status()
        return resp.json()


@app.get("/")
async def health_check():
    return {
        "status": "ok",
        "service": settings.api_title,
        "version": settings.api_version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    if settings.GATEWAY_API_KEY:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {settings.GATEWAY_API_KEY}":
            raise HTTPException(status_code=401, detail="Invalid API key")

    tenant_id = request.headers.get("X-Tenant-Id", "")
    data_bearer = request.headers.get("X-Rubot-Data-Bearer", "")

    if not tenant_id:
        raise HTTPException(status_code=400, detail="Missing X-Tenant-Id header")
    if not data_bearer and settings.RUBOT_DATA_AUTH != "open":
        raise HTTPException(status_code=400, detail="Missing X-Rubot-Data-Bearer header")

    body = await request.json()
    messages = body.get("messages", [])
    user_message = _extract_last_user_message(messages)

    if not user_message:
        raise HTTPException(status_code=400, detail="No user message found")

    logger.info(
        "request.received",
        f"tenant_id={tenant_id} msgs={len(messages)} last={user_message[:120]}",
    )

    pipeline = _get_pipeline()

    async def agent_fn() -> AgentOutput:
        resp_data = await _call_orchestrator(body, tenant_id, data_bearer)
        content = ""
        try:
            content = resp_data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError):
            pass
        usage = resp_data.get("usage", {})
        return AgentOutput(
            content=content,
            tokens={
                "input": usage.get("prompt_tokens", 0),
                "output": usage.get("completion_tokens", 0),
                "total": usage.get("total_tokens", 0),
            },
        )

    try:
        result = await pipeline.run(user_message, agent_fn)
    except Exception:
        logger.error("pipeline.error", f"guardrails pipeline failed tenant_id={tenant_id}")
        raise HTTPException(status_code=502, detail="Guardrails pipeline error")

    if result["blocked_by"]:
        logger.info(
            "request.blocked",
            f"tenant_id={tenant_id} stage={result['blocked_by']}",
        )

    return _openai_envelope(result["delivered_message"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
