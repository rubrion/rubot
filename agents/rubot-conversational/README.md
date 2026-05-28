# rubot-conversational

General-purpose conversational agent for the rubot multi-agent system.

The orchestrator routes here when no specialist agent matches the user's
question. It handles greetings, farewells, thanks, general system questions,
and cross-cutting queries that do not require specific data providers.

## Key behaviour

- Dynamically fetches connected data sources (via middleware) and other
  agents' capabilities (via `/v1/capabilities`), then injects them into the
  system prompt so the model can tell the user what the system can help with.
- Guides users toward specialist agents when data-specific queries are
  detected.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ORCHESTRATOR_API_KEY` | prod | Bearer token the orchestrator sends. Empty disables auth (dev only). |
| `MIDDLEWARE_URL` | yes | Base URL of the rubot middleware (e.g. `http://localhost:8788`). |
| `AGENT_REGISTRY_JSON` | yes | JSON object mapping `source_id` to agent base URL. |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health check |
| GET | `/v1/capabilities` | Capabilities document for the orchestrator router |
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions |

## Local test

```bash
# from the rubot/ root
./scripts/dev-setup.sh rubot-conversational
source .venv/bin/activate
cd agents/rubot-conversational
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
