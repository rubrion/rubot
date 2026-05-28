# Architecture

rubot is a five-layer stack. Each layer has a single responsibility and a
clear wire contract with its neighbours.

## Layers

| # | Layer | Tech | Where it runs |
|---|---|---|---|
| 1 | Edge / TLS | Cloudflare | global |
| 2 | Workers (gateway + middleware) | TypeScript / Hono | Cloudflare Workers |
| 3 | Agents (orchestrator + specialists) | Python / FastAPI / pydantic_ai | Railway (or any container host) |
| 4 | Upstream data sources | varies | wherever they live |
| 5 | Chat-source adapter | varies | wherever you choose |

## Request lifecycle

```
1. user sends a message to the chat-source adapter (WhatsApp/Slack/Telegram/...)

2. adapter POSTs /v1/chat/completions to rubot-gateway with
     Authorization: Bearer GATEWAY_API_KEY
     X-Chat-Source-Session-Id: <unique-per-conversation>
     X-Chat-Source-Sender-Id:  <unique-per-end-user>

3. rubot-gateway
     - mints X-Rubot-Trace-Id (32-char hex) if absent
     - resolves session → (tenant_id, short-lived data bearer)
         lookup session_bearers → if expired/missing, self-heal via
         rubot-middleware Service Binding to refresh or bind
     - forwards request to rubot-orchestrator with
         X-Tenant-Id, X-Rubot-Data-Bearer, X-Rubot-Trace-Id

4. rubot-orchestrator
     - preflight: GET rubot-middleware /api/data/<tenant>/connections
         returns which providers the tenant has linked
     - capabilities fan-out: GET <each-agent>/v1/capabilities
         (cached 30 min)
     - planner LLM picks one or more agents to dispatch to
     - calls each agent: POST <agent>/v1/chat/completions
         with the same X-* headers
     - merges responses; returns OpenAI-shaped completion

5. specialist agent (forked from rubot-agent-template)
     - runs pydantic_ai Agent
     - tools call rubot-middleware /api/example-provider/data/<tenant>/...
         with X-Rubot-Trace-Id, X-Rubot-Data-Bearer forwarded
     - emits structured log envelope per step
     - emits agent_log_v1 payload on completion

6. rubot-middleware
     - validates incoming bearer (HMAC verify, < 900 sec TTL)
     - calls upstream data source (HTTP/OAuth/JDBC/...)
     - returns JSON to the agent

7. response flows back up: agent → orchestrator → gateway → adapter → user
```

Every hop carries `X-Rubot-Trace-Id`. Every log line has the same envelope
shape. Filter by `trace_id` and the full lifecycle is one query.

## Wire contract — specialist agent

| Endpoint | Purpose |
|---|---|
| `GET /` | health |
| `GET /v1/capabilities` | `{ schema_version: 1, source_id, name, summary }` — used by orchestrator for routing |
| `POST /v1/chat/completions` | OpenAI-compatible completion |

Required inbound headers:
- `Authorization: Bearer ORCHESTRATOR_API_KEY`
- `X-Tenant-Id`
- `X-Rubot-Data-Bearer`
- `X-Rubot-Trace-Id` (set by gateway; middleware fills if absent)

## Bearer format (data bearer)

```
mbr.v1.<tenantIdB64url>.<expSec>.<sigB64url>
```

HMAC-SHA256 over `<tenantId>.<expSec>` with the secret `BEARER_SIGNING_SECRET`.
TTL clamp 60–900 seconds. Stateless verification (no DB lookup). Same secret
shared between rubot-gateway (mint) and rubot-middleware (verify).

## Structured log envelope

Every log line (Python or TS) is a JSON object:

```jsonc
{
  "timestamp": "2026-05-27T13:24:01.123Z",
  "log_level": "INFO",
  "service": "rubot-agent-template",
  "component": "app.agent.tools",
  "environment": "production",
  "deployment_hash": "a1b2c3d4",
  "tenant_id": "tenant-abc",
  "chat_source_session_id": "sess-...",
  "sender_id": "user-...",
  "trace_id": "f0e1d2c3b4a5...",
  "event_type": "tool.call.completed",
  "message": "Fetched 42 rows from example-provider",
  "extra": { "rows": 42, "elapsed_ms": 117 },
  "agent": null  // populated only on agent.log events
}
```

On `agent.log`, the `agent` field carries an `agent_log_v1` payload:
dimensions (provider/model), conversation (user message, assistant response,
system prompt snapshot, history), execution (steps with tokens/cost/timing),
problem_signals (tool errors, context overflow, …).

## Security model

| Boundary | Auth |
|---|---|
| chat-source → gateway | `Bearer GATEWAY_API_KEY` |
| gateway → orchestrator | `Bearer GATEWAY_API_KEY` (same key; orchestrator validates inbound) |
| orchestrator → specialist agent | `Bearer ORCHESTRATOR_API_KEY` |
| agent → middleware | `Bearer <data_bearer>` (short-lived, HMAC-signed) |
| gateway → middleware (internal) | `Bearer MIDDLEWARE_API_KEY` via CF Service Binding |

Each long-lived API key lives in env / secrets storage. The short-lived data
bearer is minted per request, scoped to a tenant, capped at 15 minutes.
Stateless verification means no extra DB round-trip in the hot path.

### Open mode (`RUBOT_DATA_AUTH=open`)

For local development and simple deployments that don't need tenant-scoped
data access, set `RUBOT_DATA_AUTH=open` across all services. In this mode
the entire bearer chain is bypassed: no minting, no forwarding, no
verification. Agents access all available data sources without
authentication. `BEARER_SIGNING_SECRET` is not required.

`X-Tenant-Id` still propagates (using `RUBOT_OPEN_TENANT` at the gateway)
for logging and routing, but is not enforced at the middleware.

### Manager + provisioning subsystem (`RUBOT_DATA_AUTH=bearer` only)

Bearer mode ships a small three-actor identity model so a dashboard user
can hand out scoped access without having to know what a minted bearer
is:

- **Manager** — human dashboard user. One row in `managers` (email +
  PBKDF2 password hash + email-confirmed flag + reset/confirm tokens).
  Authenticated by the HMAC-signed `rubot_session` cookie, which is
  signed with `SESSION_SIGNING_SECRET` (deliberately a different key
  from `BEARER_SIGNING_SECRET` — manager-session compromise must not
  pivot to data-bearer forgery).
- **Tenant** — `tenants.tenant_id` row. A manager owns N tenants via
  `manager_tenants(manager_id, tenant_id)`. `isManagerOwnerOf` gates
  every per-tenant admin endpoint.
- **Sender** — chat-source identity (Telegram chat id, WhatsApp E.164,
  Slack user id, etc.). `identity_bindings(sender_id → tenant_id)`
  resolves the tenant_id that `/api/internal/bind-session` mints a
  bearer for.

The PIN flow ties the three together:

1. Manager logs into the dashboard → `POST /api/provision/generate
   {tenant_id}` returns a 6-digit PIN (5-minute TTL, single-use,
   stored in the `PROVISIONING` KV with both `<pin> → tenant_id` and
   `tenant:<tenant_id> → { pin, expiresAt }` keys).
2. Manager hands the PIN to the end user out-of-band.
3. End user (any transport) sends the PIN to a public endpoint
   that forwards `POST /api/provision/consume { pin, sender_id }`.
   The route looks up the PIN, upserts `identity_bindings(sender_id →
   tenant_id)`, deletes both KV keys.
4. Future chat turns flow through `/api/internal/bind-session
   {session_id, sender_id}` — the sender → tenant_id lookup uses the
   freshly-inserted binding, so the bearer is minted for the correct
   tenant transparently.

**The entire subsystem is unmounted in open mode** — `/api/auth/*`,
`/api/provision/*`, and `/api/tenant/*` all return 404. Open-mode
deployments don't have a notion of tenant ownership or PIN-bound sender
identity to begin with, so administering those routes would be
meaningless.

### Tenant-admin API + per-tenant agent filter

Bearer mode also exposes `/api/tenant/*` (gated by the same 404
short-circuit) for the dashboard to drive integrations, agents, and
sender bindings:

- `GET/POST/DELETE /api/tenant/:tenantId/integrations[/...]` — manage
  `integration_tokens` rows (paste-API-key in v1; OAuth start flow is
  a roadmap stub).
- `GET /api/tenant/:tenantId/agents` and `POST .../:agentId/toggle` —
  per-tenant `tenant_agents.enabled`. Backed by the
  `KNOWN_AGENTS_JSON` middleware env var as the source of truth for
  which agents are registered globally.
- `GET/DELETE /api/tenant/:tenantId/senders[/...]` — list / revoke
  `identity_bindings`.
- `GET /api/tenant/:tenantId/usage` — placeholder (see
  `docs/observability.md`).

The orchestrator picks up `tenant_agents` automatically: the existing
preflight `GET /api/data/:tenantId/connections` now returns an `agents`
array alongside `connections`. The orchestrator router intersects its
registry × available providers × `enabled_agents`, so toggling an
agent off in the dashboard takes effect on the next planner round-trip
without redeploying anything.

The dashboard itself (`workers/rubot-client/`) is documented in
`docs/dashboard.md`.

### Account approval + super-admin

Manager accounts pass through four states before they can act on
tenants:

```
register → email_confirmed=0
        ─→ confirm-email → email_confirmed=1, approved=0   (pending super-admin)
                        ─→ super-admin approves → approved=1
        (revoke at any time → approved=0)
```

The `approved=1` gate is enforced by `requireApprovedManager` in
`src/utils/session.ts`, used by every `/api/tenant/*` and the
manager-session branches of `/api/provision/*`. Login itself works at
`approved=0` (cookie minted) so the dashboards can render a clear
"Pending approval" state instead of an opaque error.

A second flag `is_superadmin` lives on the same row. Super-admins
access `/api/admin/*` (always mounted in both modes) to approve /
revoke / promote / demote others. The first super-admin is bootstrapped
via the `SUPERADMIN_EMAIL` middleware env var: the first register whose
email matches lands directly in `email_confirmed=1, approved=1,
is_superadmin=1` and no confirmation email is sent. Every state change
writes an `account_audit` row.

The super-admin dashboard (`workers/rubot-superadmin/`) is documented
in `docs/superadmin.md`. `rubot-open-client` (open-mode operator
dashboard) is documented at the top of its `src/` tree; v1 only ships
the auth surface and the pending-approval screen there.

## Why this shape

- multi-tenant isolation (tenant_id pinned at the edge, propagated by header)
- LLM-driven routing across many specialists (capabilities + planner)
- end-to-end traceability (one trace_id, one log envelope shape)
- short-lived data access (no long-lived bearer ever near the LLM)
- swappable providers (orchestrator never knows specific providers; it asks
  middleware which ones are linked, then routes by capability summary)
