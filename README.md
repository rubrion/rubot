# rubot

A scaffold for building multi-agent applications. Same wire contract,
structured logging, and trace propagation pattern. Generic placeholders — fork once, fill in your domain.

## What you get

```
rubot/
├── workers/
│   ├── rubot-gateway/        CF Worker — edge entry, mints trace_id, auth
│   └── rubot-middleware/     CF Worker — data/provider proxy, identity ops
├── agents/
│   ├── rubot-orchestrator/   FastAPI — LLM-planner router across agents
│   └── rubot-agent-template/ FastAPI — fork target for specialist agents
├── shared-packages/
│   └── packages/
│       ├── rubot-config/     Python — BaseAgent + YAML config + agent_log schema
│       ├── rubot-logger/     Python — envelope logging + FastAPI middleware
│       └── rubot-logger-ts/  TS — same for CF Workers (Hono middleware)
├── chat-source/              placeholder for your messaging adapter
├── docs/                     English guides
└── scripts/                  bootstrap + project-rename helpers
```

## Architecture in 30 seconds

```
chat-source (WhatsApp/Telegram/Slack/...)
    │
    ▼  HTTP /v1/chat/completions + Bearer GATEWAY_API_KEY
                                  + X-Chat-Source-{Session,Sender}-Id
rubot-gateway (CF Worker)
    │  mints X-Rubot-Trace-Id
    │  resolves sender → tenant_id + short-lived data bearer (mbr.v1.*)
    │
    ▼  + X-Tenant-Id, X-Rubot-Data-Bearer, X-Rubot-Trace-Id
rubot-orchestrator (FastAPI)
    │  preflight /api/data/<tenant>/connections
    │  fetch /v1/capabilities from each registered agent
    │  LLM planner picks agent(s) to dispatch
    │
    ▼  fans out to specialist agents
rubot-agent-template (your fork)
    │  pydantic_ai Agent, tools call rubot-middleware
    │
    ▼
rubot-middleware (CF Worker)
    │  /api/example-provider/data/<tenant>/...
    │  /api/internal/{bind-session,refresh-bearer}
    ▼
your upstream data sources
```

Every hop carries `X-Rubot-Trace-Id`. Every log line is a JSON envelope with
the same fields. Filter by `trace_id` in your log aggregator (Axiom, Datadog,
ClickHouse, …) and you see one request's full lifecycle.

## Quick start

```bash
cd rubot

# 1. Bootstrap Python venv + editable installs of rubot-config and rubot-logger.
./scripts/dev-setup.sh rubot-agent-template

# 2. Boot the template agent.
source .venv/bin/activate
cd agents/rubot-agent-template
uvicorn app.main:app --reload --port 8000

# 3. In another terminal, hit it.
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "X-Tenant-Id: dev-tenant" \
  -H "X-Rubot-Data-Bearer: fake-bearer-for-local" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Watch the stdout JSON envelopes. Note `trace_id` is the same across all
events from one request.

## Rename rubot → your project

```bash
./scripts/init-project.sh acme-bot
```

Does a global find-replace across file names, module names, and string
literals: `rubot` → `acme-bot`, `rubot_*` → `acme_bot_*`, `Rubot` →
`AcmeBot`, `RUBOT` → `ACME_BOT`. Review the diff before committing.

## Forking a new specialist agent

```bash
cp -r agents/rubot-agent-template agents/my-agent
# edit app/agent/<name>_agent.py, app/agent/tools.py, app/prompt.txt, app/main.py
```

Full checklist: [`docs/creating-new-agent.md`](docs/creating-new-agent.md).

## Built with rubot

Projects forked from this scaffold:

- **brad** — a marketing-consultant agent suite (briefing, banner, post,
  insights) with a per-tenant brand kit and Workers AI image generation.
  _Private repo._

Built something on rubot? Open a PR adding it here.

## Docs

| Doc | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Layers, request lifecycle, security model |
| [`docs/local-dev.md`](docs/local-dev.md) | Bootstrap, editable installs, Docker build modes |
| [`docs/creating-new-agent.md`](docs/creating-new-agent.md) | Fork checklist for new specialists |
| [`docs/deploy.md`](docs/deploy.md) | Railway + Cloudflare deploy notes |
| [`docs/env-vars.md`](docs/env-vars.md) | Env var matrix per service |
