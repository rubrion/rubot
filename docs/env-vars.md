# Env vars — reference matrix

What each service reads. Keep secrets out of `.env` files that get committed.

## Data auth mode

| Var | Values | Default | Purpose |
|---|---|---|---|
| `RUBOT_DATA_AUTH` | `bearer` / `open` | `bearer` | Controls whether data-route calls require HMAC-signed minted bearers. |
| `RUBOT_OPEN_TENANT` | any string | `default` | Tenant ID used by the gateway in open mode (no session resolution). Gateway only. |

In **`open`** mode:
- Gateway skips session resolution and bearer minting.
- Orchestrator and agents accept requests without `X-Rubot-Data-Bearer`.
- Middleware data routes skip bearer verification.
- `/connections` returns all known providers as connected.
- **Manager auth + PIN provisioning are unmounted entirely.** `/api/auth/*` returns 404 `auth_disabled_in_open_mode`; `/api/provision/*` returns 404 `provisioning_disabled_in_open_mode`. Open mode has no tenant-ownership concept, so administering them would be meaningless.

Set across **all** services for consistency (same constraint as other cross-service vars).

## Shared (every Python service)

| Var | Default | Purpose |
|---|---|---|
| `RUBOT_SERVICE_NAME` | `unknown` | Sets `service` field on every log envelope. Override per-service. |
| `RUBOT_ENVIRONMENT` | `dev` | `dev` / `staging` / `production`. Tag on every log. |
| `RUBOT_DEPLOYMENT_HASH` | `RAILWAY_GIT_COMMIT_SHA[:12]` if set, else empty | Commit SHA for rollback correlation. |
| `RUBOT_CONFIG_PATH` | bundled `agents.yaml` | Path to a custom agents.yaml (rarely needed). |

## Agent-level config (rubot-config)

Pattern: `AGENT_<NAME>_<PARAM>` (uppercase, hyphens → underscores).

Examples:

```
AGENT_TEMPLATE_MODEL=gpt-4o
AGENT_TEMPLATE_TEMPERATURE=0.2
AGENT_TEMPLATE_PROVIDER=anthropic
AGENT_MY_AGENT_MAX_TOKENS=8000
```

Standard `ModelSettings` fields pass through (`temperature`, `max_tokens`,
`top_p`, `timeout`, `seed`, `thinking`, …). Anything else is auto-prefixed
with the provider name (`reasoning_effort` → `openai_reasoning_effort`).

Provider credentials (resolved by pydantic_ai directly):
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`

## rubot-gateway (Cloudflare Worker)

Bindings (in `wrangler.jsonc`):
- `DB` — D1 database `rubot_data`
- `PROVISIONING` — KV namespace
- `MIDDLEWARE` — Service binding to `rubot-middleware`

Vars (in `wrangler.jsonc`):
- `ENVIRONMENT` — `dev` / `staging` / `production`
- `RUBOT_DEPLOYMENT_HASH` — commit SHA
- `ORCHESTRATOR_URL` — orchestrator base URL

Secrets (`wrangler secret put`):

| Var | Purpose |
|---|---|
| `GATEWAY_API_KEY` | Inbound auth (chat-source → gateway). Same value as on orchestrator. |
| `ADMIN_API_KEY` | Inbound auth for `/admin/*` routes. |
| `BEARER_SIGNING_SECRET` | HMAC key for minted data bearers. **Must** match rubot-middleware. |
| `MIDDLEWARE_API_KEY` | Outbound auth (gateway → middleware internal endpoints). Same value as on middleware. |
| `STAGING_STATIC_BEARER` (staging only) | Bypass bearer for dev/test flows. |
| `STAGING_STATIC_TENANT` (staging only) | Tenant id pinned to the bypass bearer. |

## rubot-middleware (Cloudflare Worker)

Bindings:
- `DB` — D1 database `rubot_data`
- `PROVISIONING` — KV namespace (used by `/api/provision/*` PIN store in bearer mode)

Vars:
- `ENVIRONMENT`, `RUBOT_DEPLOYMENT_HASH`
- `RUBOT_DATA_AUTH` — `bearer` (default) or `open`. See "Data auth mode" above.
- `FRONTEND_URL` — base URL used to build confirmation/reset links in outbound mail. Bearer mode only.
- `MAIL_FROM` — From address on outbound mail. Bearer mode only.
- `MAIL_BRAND_NAME` — display name used inside the email body. Bearer mode only.

Secrets:

| Var | Purpose |
|---|---|
| `MIDDLEWARE_API_KEY` | Inbound auth for `/api/internal/*`. Same value as on gateway. |
| `BEARER_SIGNING_SECRET` | HMAC key for verifying minted **data** bearers. **Must** match rubot-gateway. |
| `SESSION_SIGNING_SECRET` | HMAC key for the `rubot_session` manager cookie. Bearer mode only. **Must** be different from `BEARER_SIGNING_SECRET` (separate trust domains). |
| `RESEND_API_KEY` | Optional. Empty → confirmation/reset URLs are logged to the worker console instead of sent. |
| `<PROVIDER>_*` | Provider-specific OAuth / API creds when wiring real providers. |
| `KNOWN_AGENTS_JSON` (var) | JSON array of registered agent ids the dashboard can toggle per tenant. Must mirror the keys of orchestrator's `AGENT_REGISTRY_JSON`. Bearer mode only. |
| `SUPERADMIN_EMAIL` (var) | Bootstrap super-admin. First /api/auth/register whose email matches (case-insensitive) is auto-confirmed + auto-approved + auto-elevated. Unset/empty → first super-admin must be set via D1 by hand. |

## rubot-orchestrator (Python / Railway)

| Var | Purpose |
|---|---|
| `GATEWAY_API_KEY` | Inbound auth. Same value as gateway secret. |
| `ORCHESTRATOR_API_KEY` | Outbound to specialist agents. Same value across all agents. |
| `AGENT_REGISTRY_JSON` | `{"<source-id>": "https://<agent-url>"}` — registered specialists. |
| `MIDDLEWARE_URL` | rubot-middleware base URL. Used for `/api/data/<tenant>/connections` preflight. |
| `PLANNER_BASE_URL` | (optional) Custom OpenAI-compat endpoint for the routing LLM. |
| `PLANNER_API_KEY` | (optional) Auth for the planner endpoint. |
| `PLANNER_MODEL` | `gpt-4o-mini` (default). |

## rubot-agent-template (and forks)

| Var | Purpose |
|---|---|
| `ORCHESTRATOR_API_KEY` | Inbound auth (orchestrator → agent). Empty = auth disabled (local dev only). |
| `MIDDLEWARE_BASE_URL` | rubot-middleware base URL — tools call provider data here. |
| `OPENAI_API_KEY` (or other) | LLM credential. |
| `AGENT_<SOURCE_ID>_*` | Per-agent config overrides. |

## rubot-client (Cloudflare Worker — Astro)

Bindings:
- `MIDDLEWARE` — Service binding to `rubot-middleware`. Required.
- `ASSETS` — static asset binding (auto-generated by `@astrojs/cloudflare`).

Vars:
- `RUBOT_DATA_AUTH` — must equal `bearer`. When `open`, the dashboard
  renders only a "bearer mode required" banner and refuses to read data.

No secrets live on `rubot-client` itself — it forwards the manager's
`rubot_session` cookie to middleware on every API call. The dashboard is
documented in `docs/dashboard.md`.

## rubot-open-client (Cloudflare Worker — Astro)

Bindings:
- `MIDDLEWARE` — Service binding to `rubot-middleware`. Required.
- `ASSETS` — static asset binding.

Vars:
- `RUBOT_DATA_AUTH` — pinned to `open`.

v1 surface: auth pages + pending-approval screen + a landing card.
Full open-mode global admin UI is future work.

## rubot-superadmin (Cloudflare Worker — Astro)

Bindings:
- `MIDDLEWARE` — Service binding to `rubot-middleware`. Required.
- `ASSETS` — static asset binding.

Vars: none required. Works regardless of `RUBOT_DATA_AUTH` on
middleware — `/api/admin/*` is always mounted because the super-admin
role lives on the managers row.

The first super-admin is bootstrapped via `rubot-middleware`'s
`SUPERADMIN_EMAIL` env var. See `docs/superadmin.md`.

## Cross-service constraint summary

| Var | Must match across |
|---|---|
| `GATEWAY_API_KEY` | gateway secret + orchestrator env |
| `ORCHESTRATOR_API_KEY` | orchestrator env + every specialist agent env |
| `MIDDLEWARE_API_KEY` | gateway secret + middleware secret |
| `BEARER_SIGNING_SECRET` | gateway secret + middleware secret |
| `SESSION_SIGNING_SECRET` | middleware only (single producer + consumer) — must differ from `BEARER_SIGNING_SECRET` |
| `RUBOT_DATA_AUTH` | all services (gateway + middleware + orchestrator + agents + rubot-client) |
| `KNOWN_AGENTS_JSON` | middleware var must mirror the keys of orchestrator's `AGENT_REGISTRY_JSON` |

Mismatch → 401s (bearer mode) or mixed behaviour (auth mode). Verify after every rotation.
