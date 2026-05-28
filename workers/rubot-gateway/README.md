# Rubot Gateway

Cloudflare Worker that serves as the edge entry point of the rubot stack.
Accepts requests from a chat-source adapter (a generic placeholder for
whatever chat front-end is plugged in) and forwards them to
`rubot-orchestrator`.

Responsibilities:

1. Authenticate the inbound chat request (`GATEWAY_API_KEY` from the
   chat-source adapter).
2. Mint a `trace_id` at the edge via `@rubot/logger`'s `rubotLogging()`
   middleware so every downstream hop emits joinable logs.
3. Resolve the per-session minted bearer keyed by
   `X-Chat-Source-Session-Id` (written by the chat-source adapter when it
   binds the session via the middleware).
4. Self-heal expired bearers by calling the middleware's
   `refresh-bearer` over a service binding.
5. Self-heal missing bindings by calling `bind-session` when the
   chat-source adapter has stamped a trusted `X-Chat-Source-Sender-Id`.
6. Strip identity markers from message text (defense-in-depth against
   prompt injection — the bearer is the actual auth boundary).
7. Forward to `rubot-orchestrator` with `X-Tenant-Id`, `X-Rubot-Data-Bearer`,
   and `X-Rubot-Trace-Id` headers; proxy the response back to the caller.

## Topology

```
chat-source adapter
  │   stamps X-Chat-Source-Session-Id (and optional X-Chat-Source-Sender-Id)
  │   on each POST /v1/chat/completions
  ▼
rubot-gateway   ←── this worker (Cloudflare Workers)
  │
  ├── D1: rubot_data         (read session_bearers / identity_bindings)
  ├── KV: PROVISIONING       (placeholder — not used in the happy-path)
  ├── env.MIDDLEWARE (svc)   (refresh/bind self-heal calls)
  └── ORCHESTRATOR_URL       (forward to rubot-orchestrator)
```

The gateway forwards crypto operations to the middleware in the deployed
topology — the middleware is the canonical signer of `mbr.v1.*` bearers.
A local copy of the HMAC mint/verify primitives lives in
`src/lib/bearer.ts` for symmetry and future direct-mint paths.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/chat/completions` | `GATEWAY_API_KEY` | OpenAI-compatible chat completions. Resolves session → bearer, forwards to `ORCHESTRATOR_URL`. Streams when `stream: true`. |
| GET  | `/admin/identity-bindings` | `ADMIN_API_KEY` | List sender → tenant mappings. Placeholder schema. |
| POST | `/admin/identity-bindings` | `ADMIN_API_KEY` | Upsert sender → tenant mapping. |
| DELETE | `/admin/identity-bindings/:sender_id` | `ADMIN_API_KEY` | Remove a mapping. |

## Session bearer resolution

Per-turn flow inside `/v1/chat/completions`:

1. `STAGING_STATIC_BEARER` + `STAGING_STATIC_TENANT` set?
   → short-circuit and use them. This is the only resolution path that
   works out of the box (intended for `staging-test`). Everything below
   is the production shape; real wire-up is downstream user work.
2. Read `X-Chat-Source-Session-Id`. Missing → return the
   "Unrecognized device" template with `CALLBACK_URL`.
3. `SELECT tenant_id, bearer, expires_at FROM session_bearers WHERE session_id = ?`
4. Row exists and `expires_at > now` → forward with `bearer`.
5. Row exists but expired → call middleware
   `POST /api/internal/refresh-bearer` via service binding.
6. No row, but `X-Chat-Source-Sender-Id` is present → call middleware
   `POST /api/internal/bind-session` via service binding, then re-read
   the row.
7. No row and no sender id → return the unlinked template.

All self-heal calls are on-demand only — no polling, no background work.

## Environment

`wrangler.jsonc` declares plaintext vars. Secrets are set via
`wrangler secret put <NAME>`:

| Var | Type | Purpose |
|---|---|---|
| `ORCHESTRATOR_URL` | plaintext | Base URL of `rubot-orchestrator`. |
| `ENVIRONMENT` | plaintext | `dev` / `staging` / `production`. |
| `RUBOT_DEPLOYMENT_HASH` | plaintext | Build identifier surfaced in log envelopes. |
| `CALLBACK_URL` | plaintext | Public link URL embedded in the unlinked-device response. |
| `CF_ACCESS_CLIENT_ID` | plaintext | Service token ID for Cloudflare Access in front of the orchestrator (optional). |
| `CF_ACCESS_CLIENT_SECRET` | secret | Matching service token secret (optional). |
| `GATEWAY_API_KEY` | secret | Bearer the chat-source adapter sends inbound. |
| `ADMIN_API_KEY` | secret | Bearer required for `/admin/identity-bindings` CRUD. |
| `BEARER_SIGNING_SECRET` | secret | HMAC-SHA256 key for `mbr.v1.*` bearers. Centralized in `src/lib/bearer.ts`. |
| `MIDDLEWARE_API_KEY` | secret | Service key for the `refresh-bearer` / `bind-session` self-heal callbacks. |
| `STAGING_STATIC_BEARER` | secret (optional) | Static `mbr.v1.*` bearer for the `staging-test` happy-path. |
| `STAGING_STATIC_TENANT` | plaintext (optional) | Static tenant id for the `staging-test` happy-path. |

Bindings:

| Binding | Resource | Purpose |
|---|---|---|
| `DB` | D1 database `rubot_data` | Reads `session_bearers`, `identity_bindings`. |
| `PROVISIONING` | KV namespace | Reserved for future provisioning state. |
| `MIDDLEWARE` | Worker service `rubot-middleware` | Calls `/api/internal/refresh-bearer` and `/api/internal/bind-session`. |

## Development

```bash
npm install
npm run dev        # wrangler dev
npm run cf-typegen # regenerate worker-configuration.d.ts
```

`@rubot/logger` is consumed as a local file dep
(`file:../../shared-packages/packages/rubot-logger-ts`). Run
`npm install` again whenever the shared package changes shape.
