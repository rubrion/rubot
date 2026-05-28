# rubot-middleware

Cloudflare Worker that acts as the data/provider proxy for the rubot
stack. It mints short-lived per-tenant bearers for `rubot-gateway`,
exposes a `/connections` preflight that the orchestrator uses to
discover which providers a tenant has wired in, and hosts one sub-app
per connected provider under `/api/<provider>/data/:tenantId/*`.

## Layout

```
src/
├── index.ts              Hono router + data-auth middleware + logging
├── routes/
│   ├── internal.ts       /api/internal/bind-session, /refresh-bearer
│   ├── data.ts           /api/data/:tenantId/connections
│   ├── auth.ts           /api/auth/{register,login,logout,me,confirm-email,…}
│   └── provision.ts      /api/provision/{generate,pin/:tenantId,consume}
├── providers/
│   └── example-provider/ /api/example-provider/data/:tenantId/*
└── utils/
    ├── minted-bearer.ts  HMAC mint/verify — shared format with gateway
    ├── token-service.ts  integration_tokens helpers + refresh stub
    ├── tenant-auth.ts    long-lived tenant-secret verification
    ├── password.ts       PBKDF2-SHA256 hashing for manager passwords
    ├── session.ts        HMAC-signed rubot_session cookie
    ├── manager.ts        managers + manager_tenants CRUD + ownership
    ├── email.ts          Resend wrapper with dev-log fallback
    ├── uuid.ts           v4 UUID generator
    └── validate.ts       shared regex constants
```

## Bindings

| Name           | Kind        | Purpose                                 |
| -------------- | ----------- | --------------------------------------- |
| `DB`           | D1          | `rubot_data` database (schema.sql)      |
| `PROVISIONING` | KV          | Reserved for provisioning PINs / nonces |

## Secrets

Set with `wrangler secret put <name>`:

| Name                    | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `MIDDLEWARE_API_KEY`    | Inbound auth from `rubot-gateway` (Service Binding)    |
| `BEARER_SIGNING_SECRET` | HMAC key for `mbr.v1...` tokens (shared with gateway)  |

## Local setup

```sh
npm install
wrangler d1 create rubot_data        # copy the id into wrangler.jsonc
wrangler kv:namespace create PROVISIONING
wrangler d1 execute rubot_data --file=schema.sql
wrangler secret put MIDDLEWARE_API_KEY
wrangler secret put BEARER_SIGNING_SECRET
npm run dev
```

## Routes

### Internal (Service Binding only, `Authorization: Bearer
$MIDDLEWARE_API_KEY`)

- `POST /api/internal/bind-session` — body `{ session_id, tenant_id |
  sender_id, ttl_sec? }`. Resolves the tenant (directly or via
  `identity_bindings`), mints a bearer, upserts `session_bearers`.
- `POST /api/internal/refresh-bearer` — body `{ session_id, ttl_sec?
  }`. Re-mints in place when the existing row is expired.

### Public data (minted bearer or long-lived tenant secret)

- `GET /api/data/:tenantId/connections` — preflight, returns
  `{ connections: [{ provider, connected, expired }] }`.
- `GET /api/example-provider/data/:tenantId/sample` — canned payload.
- `GET /api/example-provider/data/:tenantId/echo` — echoes query string.

### Identity (stubs)

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET  /api/auth/me`

All four are skeleton implementations — they validate shape but do not
hit the DB. Replace before production.

## Adding a new provider

1. Create `src/providers/<provider>/index.ts` exporting a `Hono`
   sub-app with `/data/:tenantId/...` routes.
2. Mount it in `src/index.ts`:
   ```ts
   apiApp.use("/<provider>/data/*", dataAuthMiddleware);
   apiApp.route("/<provider>", myProviderApp);
   ```
3. Add the provider id to `KNOWN_PROVIDERS` in `src/routes/data.ts`.
4. Add OAuth refresh logic to `src/utils/token-service.ts` (or its own
   file) and persist tokens in `integration_tokens`.
