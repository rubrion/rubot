# Local development

Run rubot on your machine. Three modes, in order of how much of the stack
you spin up.

## Prerequisites

- Python 3.11+ (`python3 --version`)
- Node 18+ + npm (for the CF Workers)
- Docker + Docker Buildx (only for the Docker-build mode)

## Bootstrap (once per machine)

```bash
cd rubot
./scripts/dev-setup.sh                       # shared packages only
./scripts/dev-setup.sh rubot-agent-template  # shared packages + the template agent
./scripts/dev-setup.sh rubot-orchestrator    # or the orchestrator
```

What the script does:

1. Creates `.venv/` with Python 3.11+.
2. `pip install -e ./shared-packages/packages/rubot-logger[fastapi,dev]`
3. `pip install -e ./shared-packages/packages/rubot-config[dev]`
4. (optional) `pip install -e ./agents/<name>[dev]`

After bootstrap, any edit in `shared-packages/packages/*` is picked up
immediately — no reinstall.

```bash
source .venv/bin/activate
```

## Mode 1 — single agent, hot-reload

For iterating on one specialist agent.

```bash
source .venv/bin/activate
cd agents/rubot-agent-template
RUBOT_DATA_AUTH=open uvicorn app.main:app --reload --port 8000
```

Smoke test (open mode — no bearer needed):

```bash
curl http://localhost:8000/
curl -H "X-Tenant-Id: dev" http://localhost:8000/v1/capabilities
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "X-Tenant-Id: dev" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

With bearer mode (`RUBOT_DATA_AUTH=bearer` or unset), add
`-H "X-Rubot-Data-Bearer: <valid-minted-bearer>"`.

Watch stdout for JSON envelopes. `trace_id` is minted by the middleware on
the first request.

## Mode 2 — orchestrator + one agent

For testing routing.

```bash
# terminal A: specialist
source .venv/bin/activate && cd agents/rubot-agent-template
RUBOT_DATA_AUTH=open uvicorn app.main:app --reload --port 8000

# terminal B: orchestrator
source .venv/bin/activate && cd agents/rubot-orchestrator
RUBOT_DATA_AUTH=open \
  AGENT_REGISTRY_JSON='{"template":"http://localhost:8000"}' \
  MIDDLEWARE_URL=http://localhost:8788 \
  GATEWAY_API_KEY=dev-gw-key \
  ORCHESTRATOR_API_KEY=dev-orch-key \
  uvicorn app.main:app --reload --port 8001
```

Hit the orchestrator (open mode — no bearer needed):

```bash
curl -X POST http://localhost:8001/v1/chat/completions \
  -H "Authorization: Bearer dev-gw-key" \
  -H "X-Tenant-Id: dev" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Inspect logs in both terminals — same `trace_id` appears in both.

## Mode 3 — full stack with Workers

For end-to-end testing including the CF Workers.

```bash
# terminal A: middleware worker
cd workers/rubot-middleware
npm install
npx wrangler dev --port 8788

# terminal B: gateway worker
cd workers/rubot-gateway
npm install
npx wrangler dev --port 8787

# terminal C: orchestrator (port 8001)
# terminal D: specialist agent (port 8000)
```

Hit the gateway:

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "X-Chat-Source-Session-Id: $(uuidgen)" \
  -H "X-Chat-Source-Sender-Id: +15555550100" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

`trace_id` minted at the gateway propagates through middleware → orchestrator
→ agent → middleware again, and you should see one consistent id in all
four services' logs.

### Bearer-mode manager + PIN bootstrap

In **bearer mode**, the data-route bearer chain is driven by a sender→tenant
binding written by `/api/provision/consume`. To set that binding up
end-to-end:

```bash
# 0. one-time: schema + KV namespace
cd workers/rubot-middleware
npx wrangler d1 execute rubot_data --local --file=schema.sql

# 1. register a manager (RESEND_API_KEY empty → URL logged to stderr)
curl -X POST http://localhost:8788/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"correcthorse"}'
# → { "success": true, "data": { "pending_confirmation": true } }
# Grab the confirmation URL from the worker log; visit it in a browser
# (or curl -L) — that flips email_confirmed=1 and sets rubot_session cookie.

# 2. log in for the session cookie
curl -c /tmp/rubot.cookies -X POST http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"correcthorse"}'

# 3. claim a tenant (manager_id from /api/auth/me)
MANAGER_ID=$(curl -s -b /tmp/rubot.cookies http://localhost:8788/api/auth/me \
  | jq -r .data.manager_id)
TENANT_ID=demo-tenant
npx wrangler d1 execute rubot_data --local \
  --command "INSERT INTO manager_tenants (manager_id, tenant_id) VALUES ('$MANAGER_ID', '$TENANT_ID');"
npx wrangler d1 execute rubot_data --local \
  --command "INSERT INTO tenants (tenant_id, secret_hash) VALUES ('$TENANT_ID', 'unused');"

# 4. generate a PIN for that tenant
curl -b /tmp/rubot.cookies -X POST http://localhost:8788/api/provision/generate \
  -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT_ID\"}"
# → { "success": true, "data": { "pin": "172845", "tenant_id": "demo-tenant", "expires_at": ... } }

# 5. burn the PIN as the public consume endpoint (no auth)
PIN=172845
SENDER_ID=tg:123456789
curl -X POST http://localhost:8788/api/provision/consume \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"$PIN\",\"sender_id\":\"$SENDER_ID\"}"
# → { "success": true, "data": { "linked": true, "tenant_id": "demo-tenant", "sender_id": "tg:123456789" } }

# 6. the next gateway turn that arrives with X-Chat-Source-Sender-Id: tg:123456789
#    will resolve to tenant_id=demo-tenant transparently via identity_bindings.
```

In **open mode** all of the above is skipped: `/api/auth/*` and
`/api/provision/*` return 404, the gateway uses `RUBOT_OPEN_TENANT` as
the tenant_id, and the bearer chain is bypassed end-to-end.

## Mode 4 — Docker build (validate production image)

To validate exactly what the deploy host will run:

```bash
# from rubot/ root
docker build \
  -f agents/rubot-agent-template/Dockerfile \
  -t rubot-agent-template:dev \
  .

docker run --rm -p 8000:8000 \
  -e RUBOT_SERVICE_NAME=rubot-agent-template \
  -e ORCHESTRATOR_API_KEY=dev-orch-key \
  rubot-agent-template:dev

curl http://localhost:8000/
```

If you later extract `shared-packages/` to its own private repo and switch
the Dockerfile to `pip install git+https`, also pass a BuildKit secret:

```bash
export GITHUB_TOKEN=ghp_xxxxx
docker buildx build \
  --secret id=GITHUB_TOKEN,env=GITHUB_TOKEN \
  --build-arg SHARED_PACKAGES_REF=main \
  -f agents/rubot-agent-template/Dockerfile \
  -t rubot-agent-template:dev \
  .
```

## Running tests

```bash
# shared packages
cd shared-packages/packages/rubot-config && pytest -v
cd shared-packages/packages/rubot-logger && pytest -v

# orchestrator
cd agents/rubot-orchestrator && pytest -v
```

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: rubot_config` | venv not active or bootstrap not run | `source .venv/bin/activate`, rerun `./scripts/dev-setup.sh` |
| `pydantic_ai.exceptions.UserError: No model configured` | `OPENAI_API_KEY` (or other provider) not exported | export before running uvicorn |
| Edits in `shared-packages/` not picked up | installed non-editable | reinstall with `pip install -e ./shared-packages/packages/...` |
| `trace_id` missing in logs | middleware not registered | confirm `app.add_middleware(RubotLoggingMiddleware)` |
| Docker build fails on shared-packages COPY | wrong build context | run `docker build` from `rubot/` root, not the agent dir |
