# Deploy

rubot's reference deploy targets are **Railway** (Python agents) +
**Cloudflare Workers** (gateway + middleware). The stack is plain enough to
run on any container host + edge platform; adapt as needed.

## Topology

```
┌─────────────────────────────────────────────────────┐
│ Cloudflare (edge)                                   │
│   rubot-gateway          rubot-middleware           │
└─────────────────┬──────────────────┬────────────────┘
                  │                  │
                  ▼ HTTPS / mTLS     ▼ HTTPS
┌─────────────────────────────────────────────────────┐
│ Railway (or any container host) — private network   │
│   rubot-orchestrator                                │
│   rubot-agent-<one>                                 │
│   rubot-agent-<two>                                 │
│   ...                                               │
└─────────────────────────────────────────────────────┘
```

Workers reach the Railway services via a public tunnel (Cloudflare Tunnel
with Zero Trust) or direct HTTPS with IP allowlisting.

## Cloudflare Workers

Each worker has a `wrangler.jsonc`. From its directory:

```bash
npm install
wrangler login              # once per machine
wrangler d1 create rubot_data
# copy the database_id into wrangler.jsonc
wrangler d1 execute rubot_data --file=schema.sql      # rubot-middleware only

# secrets (one-time):
wrangler secret put GATEWAY_API_KEY        # rubot-gateway
wrangler secret put ADMIN_API_KEY          # rubot-gateway
wrangler secret put BEARER_SIGNING_SECRET  # both workers (same value)
wrangler secret put MIDDLEWARE_API_KEY     # both (same value)

wrangler deploy
```

Per-env (staging / production), use separate names and `--env`:

```jsonc
{
  "env": {
    "staging":    { "name": "rubot-gateway-staging" },
    "production": { "name": "rubot-gateway" }
  }
}
```

```bash
wrangler deploy --env staging
wrangler deploy --env production
```

## Railway services

Each Python agent ships as a Dockerfile. Repo-root build context.

**Pre-flight per service:**

1. Create the Railway service, point at your repo.
2. **Root Directory**: `/rubot`
3. **Dockerfile Path**: `agents/<name>/Dockerfile`
4. **Watch Paths**: `rubot/agents/<name>/**`, `rubot/shared-packages/**`
5. Set env vars (see [`env-vars.md`](env-vars.md)).
6. Generate domain (private internal — agents talk over Railway's
   private network).

**Shared packages — single repo vs. extracted:**

- Single repo (default): Dockerfile copies `shared-packages/` from the build
  context. No build secret needed.
- Extracted (future): Dockerfile uses
  `pip install git+https://${GITHUB_TOKEN}@github.com/<org>/rubot-shared-packages.git@${SHARED_PACKAGES_REF}#subdirectory=packages/<name>`.
  Set `GITHUB_TOKEN` as a Railway **build secret** on every service. Token
  needs `repo` read on the shared repo.

**Per-environment private domains** (Railway):

- Staging: `<name>-staging.railway.internal:<port>`
- Production: `<name>.railway.internal:<port>`

The orchestrator's `AGENT_REGISTRY_JSON` references these internal URLs:

```
AGENT_REGISTRY_JSON={"template":"http://rubot-agent-template.railway.internal:8000"}
```

## Cross-environment consistency

These must match across services in the same env:

| Var | Where | Value |
|---|---|---|
| `GATEWAY_API_KEY` | rubot-gateway secret + rubot-orchestrator env | same |
| `ORCHESTRATOR_API_KEY` | rubot-orchestrator env + every specialist agent env | same |
| `MIDDLEWARE_API_KEY` | rubot-gateway secret + rubot-middleware secret | same |
| `BEARER_SIGNING_SECRET` | rubot-gateway secret + rubot-middleware secret | same |

If `BEARER_SIGNING_SECRET` mismatches between gateway and middleware, every
agent → middleware call fails 401. Verify before promoting.

## Centralized logging

Every service emits one JSON line per event with a common envelope shape.
Pipe them to whichever aggregator you use:

- **Cloudflare Logpush → Axiom** (gateway + middleware): set up in CF
  dashboard, no code change. Workers' `observability.enabled = true` is
  already set in `wrangler.jsonc`.
- **Railway log drain → Axiom HTTP ingest** (Python agents): set on each
  service's Settings → Log Drains.

Recommended Axiom dataset fields: `tenant_id`, `trace_id`, `event_type`,
`service`, `environment`. Filter by `trace_id` to follow one request across
all six services.

## Smoke tests after deploy

```bash
# health
curl https://<gateway-url>/                              # → ok
curl https://<middleware-url>/                           # → ok

# end-to-end (use a real bearer in production)
curl -X POST https://<gateway-url>/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "X-Chat-Source-Session-Id: smoke-$(uuidgen)" \
  -H "X-Chat-Source-Sender-Id: smoke-sender" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Pull the response's `X-Rubot-Trace-Id` header, search Axiom for it. You
should see events from gateway → orchestrator → agent → middleware in one
trace.

## Rolling back

Workers: `wrangler rollback` (or redeploy the previous git ref).
Railway: redeploy the previous commit on the affected service. The wire
contract is stable across versions, so you can rollback one service at a
time without breaking neighbours — provided you haven't bumped a shared
package's version simultaneously.
