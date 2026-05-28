# Creating a new specialist agent

Each specialist is a fork of [`agents/rubot-agent-template/`](../agents/rubot-agent-template/),
the abstract scaffold that wires `BaseAgent`, `RubotLoggingMiddleware`,
OpenAI-compatible endpoints, and trace propagation.

Plan a few things before coding:

1. **`source_id`** — slug, no spaces, unique across registered agents.
   Used in:
   - `agent_name` (key in `rubot_config/agents.yaml`, env var prefix)
   - `source_id` (in `/v1/capabilities`)
   - service name (`<source-id>-agent` or whatever convention you pick)
   - key in the orchestrator's `AGENT_REGISTRY_JSON`
2. **LLM provider + model** — OpenAI, Anthropic, Groq, Mistral, or any
   provider via custom `base_url`. Default is `openai:gpt-4o-mini` from the
   `defaults:` block of `agents.yaml`.
3. **Data sources** — which upstream APIs/DBs the agent calls. Through
   rubot-middleware (preferred — gives you tenant scoping and short-lived
   bearers) or direct.
4. **Tools** — one tool per capability (`get_<thing>`, `query_<thing>`).
   Have the list before writing code.

---

## Step 1 — fork the scaffold

```bash
cp -r agents/rubot-agent-template agents/<source-id>-agent
cd agents/<source-id>-agent
```

The structure you get:

```
agents/<source-id>-agent/
├── Dockerfile
├── pyproject.toml
├── start.sh
└── app/
    ├── main.py
    ├── config.py
    ├── models.py
    ├── prompt.txt
    └── agent/
        ├── deps.py
        ├── tools.py
        ├── template_agent.py    # rename to <source-id>_agent.py
        └── runner.py
```

## Step 2 — required renames

### `pyproject.toml`
`name = "rubot-agent-template"` → `name = "<source-id>-agent"`

### `app/agent/template_agent.py`
- Rename file to `app/agent/<source-id>_agent.py`
- `class TemplateAgent` → `class <SourceId>Agent`
- `agent_name = "template"` → `agent_name = "<source-id>"`
- All `template_agent` variable usages → `<source-id>_agent`

### `app/agent/runner.py`
Update the import to point at the renamed module.

### `app/main.py`
- `configure_logger(service="rubot-agent-template")` → `service="<source-id>-agent"`
- `_CAPABILITIES`:
  - `source_id="template"` → `"<source-id>"`
  - `name="Template Agent"` → user-friendly name
  - `summary=...` → **precise** description of what this agent answers. The
    orchestrator's LLM planner reads this string verbatim to decide whether
    to dispatch to you. List the data types and question shapes the agent
    handles, explicitly.
- `model="template"` in `ChatCompletionResponse` → your `source_id`

### `Dockerfile`
- `COPY agents/rubot-agent-template/...` → `COPY agents/<source-id>-agent/...`

### `app/config.py`
- Rename `TEMPLATE_API_KEY` / `TEMPLATE_BASE_URL` etc. to provider-specific
  env vars (`<PROVIDER>_API_KEY`).
- Add any extra config the agent needs.

## Step 3 — model config (optional)

If `openai:gpt-4o-mini` works, do nothing. The agent boots from the
`defaults:` block of `agents.yaml` with a logged warning.

For a different model, edit
`shared-packages/packages/rubot-config/rubot_config/agents.yaml`:

```yaml
agents:
  <source-id>:
    provider: openai
    model: gpt-5.1
    max_tokens: 8000
    reasoning_effort: high
```

Per-deployment overrides via env vars:

```
AGENT_<SOURCE_ID>_MODEL=gpt-4o
AGENT_<SOURCE_ID>_MAX_TOKENS=4096
```

(Agent-name normalization: hyphens → underscores, uppercase.)

## Step 4 — write the system prompt

`app/prompt.txt`. A solid specialist prompt has:

- **Persona** — what the agent is expert at.
- **Hard rules** — never fabricate, never quote numbers without a source,
  cite when relevant.
- **Output shape** — opening, body, closing. Keep it tight.
- **Placeholders** — `{reference_date}` and any context the `system_prompt`
  callback injects.

## Step 5 — implement tools

In `app/agent/tools.py`, one `async` function per capability:

```python
async def get_things(
    ctx: RunContext[AgentDeps],
    arg: str,
) -> dict[str, Any]:
    """One-line description; this docstring becomes the tool description."""
    url = f"{settings.MIDDLEWARE_BASE_URL}/api/example-provider/data/{ctx.deps.tenant_id}/things"
    headers = _forward_trace_headers({
        "Authorization": f"Bearer {ctx.deps.data_bearer}",
    })

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url, headers=headers, params={"arg": arg})
        r.raise_for_status()
        return r.json()
```

Rules:

- In open mode (`RUBOT_DATA_AUTH=open`), `ctx.deps.data_bearer` is empty.
  Only add the `Authorization` header when the bearer is non-empty. The
  manager + PIN subsystem (`/api/auth/*`, `/api/provision/*`) is also
  unmounted in open mode — sender→tenant binding is bypassed entirely,
  and the gateway uses `RUBOT_OPEN_TENANT` instead. If your agent needs
  per-sender isolation, deploy in bearer mode and follow the manager
  bootstrap in `docs/local-dev.md`.
- **Always** use `_forward_trace_headers()` on outbound httpx calls — it
  reads `trace_id_var` and adds `X-Rubot-Trace-Id`.
- Log `tool.call.started` / `.completed` / `.failed` with `get_logger()`.
- On error, **return** `{"error": "..."}` instead of raising. The LLM
  handles error dicts gracefully; raises kill the run.
- Never log the `data_bearer`.

Register tools in `<source-id>_agent.py`:

```python
<source-id>_agent.tool(get_things)
```

## Step 6 — smoke test

```bash
cd <repo-root>/rubot
./scripts/dev-setup.sh <source-id>-agent
source .venv/bin/activate
cd agents/<source-id>-agent

# minimal env
cat > .env <<EOF
OPENAI_API_KEY=sk-...
ORCHESTRATOR_API_KEY=
MIDDLEWARE_BASE_URL=http://localhost:8788
EOF

uvicorn app.main:app --reload --port 8000
```

In another terminal:

```bash
curl http://localhost:8000/
curl -H "X-Tenant-Id: dev" http://localhost:8000/v1/capabilities
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "X-Tenant-Id: dev" \
  -H "X-Rubot-Data-Bearer: fake-bearer" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"<test question>"}]}'
```

Check:

- [ ] `/v1/capabilities` returns the right `source_id` and `summary`.
- [ ] `/v1/chat/completions` returns a non-empty answer.
- [ ] stdout logs are JSON envelopes (not plain text).
- [ ] `trace_id` is the same across every event of one request.
- [ ] An `agent.log` event with `_schema=agent_log_v1` lands after each run.

## Step 7 — register with the orchestrator

Edit `agents/rubot-orchestrator`'s env (`.env` locally, env vars on
production):

```
AGENT_REGISTRY_JSON={"template":"http://localhost:8000","<source-id>":"http://localhost:8002"}
```

For production, point at the deployed service URL.

## Step 8 — deploy

See [`deploy.md`](deploy.md). Pre-deploy checklist:

- [ ] Branch merged.
- [ ] Env vars set on the deploy host (see [`env-vars.md`](env-vars.md)).
- [ ] `AGENT_REGISTRY_JSON` on the orchestrator updated to include the new
      agent's URL.
- [ ] If you changed `agents.yaml`, that shared-package change is shipped
      (rebuilt Docker image or tagged release of an extracted shared repo).

## PR checklist

- [ ] `agents/<source-id>-agent/` is self-contained — no edits to other
      agents.
- [ ] No imports of `app.agent.template_agent` anywhere.
- [ ] No literal `"template"` or `"Template Agent"` in code except comments
      explaining the fork.
- [ ] `_CAPABILITIES.summary` reads like routing prose — precise, no marketing.
- [ ] Tools emit `tool.call.*` events and forward trace_id.
- [ ] `.env` not committed.
- [ ] If you touched `shared-packages/`, that change is its own commit/PR.

## Anti-patterns

- ❌ Import `rubot_config.BaseAgent` but instantiate `pydantic_ai.Agent`
   directly — you lose the auto-emitted `agent_log` payload.
- ❌ Use `print()` or `logging.basicConfig()` instead of
   `rubot_logger.get_logger()`.
- ❌ Omit `RubotLoggingMiddleware` — `trace_id` won't appear and cross-service
   correlation is impossible.
- ❌ Pass `data_bearer` as a query string. Always header.
- ❌ Hardcode `tenant_id` or a customer name. Tenants come from the
   `X-Tenant-Id` header.
- ❌ Multiple sequential upstream calls without timeouts. Use
   `asyncio.gather` + per-call timeout.
- ❌ Write a new `rubot_logger/` module inside the agent. Always import from
   the shared package.
