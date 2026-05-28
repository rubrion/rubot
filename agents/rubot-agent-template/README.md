# rubot-agent-template

**Scaffold only — NOT deployed.** Fork this when adding a new rubot specialist agent.

Every Pydantic AI specialist follows the same wiring:

- `rubot_config.BaseAgent` — YAML/env-driven model config + auto-emitted `agent_log_v1` payloads
- `rubot_logger` — structured JSON envelope, contextvars, FastAPI middleware
- OpenAI-compatible `/v1/chat/completions` + `/v1/capabilities`
- Standard headers: `X-Tenant-Id`, `X-Rubot-Data-Bearer`, `X-Rubot-Trace-Id`

It boots and answers locally, but is not registered with the orchestrator routing table.

## Forking checklist

1. Copy the directory: `cp -r rubot/agents/rubot-agent-template rubot/agents/<your-agent>` (e.g. `rubot-agent-weather`).
2. Rename the agent class in `app/agent/template_agent.py`:
   - class `TemplateAgent` -> `WeatherAgent`
   - `agent_name = "template"` -> `agent_name = "weather"`
3. Rewrite `source_id` and `summary` in `app/main.py` -> `_CAPABILITIES`. The summary is what the orchestrator reads to route — be precise about what your agent answers.
4. Change `configure_logger(service="rubot-agent-template")` to your service name.
5. Replace `app/prompt.txt` with your provider-specific system prompt. Keep the `{reference_date}` placeholder.
6. Replace the example tool in `app/agent/tools.py` with real provider calls. Keep the `_forward_trace_headers()` helper so trace ids propagate.
7. Update `app/config.py` — rename `TEMPLATE_API_KEY` / `TEMPLATE_BASE_URL` to your provider's env vars and add anything else you need.
8. If your agent needs non-default model settings, add a YAML block in `rubot/shared-packages/packages/rubot-config/rubot_config/agents.yaml`:
   ```yaml
   agents:
     weather:
       provider: openai
       model: gpt-5.1
       max_tokens: 8000
       reasoning_effort: high
   ```
9. Update the `COPY agents/rubot-agent-template/...` paths in `Dockerfile` to point at your new agent directory.
10. Update `pyproject.toml` `name = "rubot-agent-template"` -> `name = "rubot-agent-weather"`.

## Standard structure

```
rubot/agents/<your-agent>/
├── Dockerfile               # installs shared packages from local paths
├── pyproject.toml
├── start.sh                 # uvicorn entrypoint
└── app/
    ├── main.py              # FastAPI app, middleware, endpoints
    ├── config.py            # Settings (env vars)
    ├── models.py            # OpenAI-compat models + AgentCapabilities
    ├── prompt.txt           # system prompt template
    └── agent/
        ├── deps.py          # AgentDeps (tenant_id, data_bearer, ...)
        ├── tools.py         # @tool functions — provider calls
        ├── <name>_agent.py  # BaseAgent subclass + tool registration
        └── runner.py        # OpenAI-style messages <-> Pydantic AI
```

## What's standard (don't change without reason)

- `RubotLoggingMiddleware` extracts `X-Rubot-Trace-Id`, `X-Tenant-Id`, `X-Chat-Source-Session-Id`, and `X-Chat-Source-Sender-Id` into contextvars.
- `BaseAgent.run()` automatically emits an `agent_log_v1` payload via `rubot_logger.info("agent.log", ..., agent=payload)`.
- `_forward_trace_headers()` in `tools.py` adds `X-Rubot-Trace-Id` to upstream `httpx` calls so logs across services share one id.
- Auth: `ORCHESTRATOR_API_KEY` env var, validated as `Authorization: Bearer ...`. Empty value disables auth (dev only).
- Health check at `GET /`.

## Local test

```bash
# from the rubot/ root
./scripts/dev-setup.sh rubot-agent-template
source .venv/bin/activate
cd agents/rubot-agent-template
uvicorn app.main:app --reload --port 8000

# in another terminal
curl http://localhost:8000/
curl -H "X-Tenant-Id: dev-tenant" http://localhost:8000/v1/capabilities
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "X-Tenant-Id: dev-tenant" \
  -H "X-Rubot-Data-Bearer: fake-token" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Watch the JSON envelope appear in stdout — `trace_id` is minted by the middleware on the first request.
