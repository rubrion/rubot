# Dashboard (`rubot-client`)

Manager-facing admin UI for the bearer-mode rubot scaffold. Astro on
Cloudflare Workers; talks to `rubot-middleware` over a Service Binding.

## Topology

```
Browser ──▶ rubot-client (Astro SSR + /api/proxy/[...path].ts)
                          │
                          └── Service Binding: MIDDLEWARE
                                     │
                                     ▼
                              rubot-middleware
                                /api/auth/*
                                /api/tenant/*
                                /api/provision/*
                                /api/data/*
```

- All sensitive routes live on rubot-middleware. `rubot-client` is pure
  UI plus a cookie-forwarding proxy at `/api/proxy/[...path].ts`.
- The `rubot_session` HMAC cookie is signed by middleware with
  `SESSION_SIGNING_SECRET` and verified by middleware on every call —
  `rubot-client` never touches the signing key.

## Routes

| Path | Auth | Purpose |
|---|---|---|
| `/` | none | redirect → `/dashboard` (logged in) or `/login` |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | none | auth flows; POST to `/api/proxy/auth/*` |
| `/dashboard` | session | list owned tenants + create new |
| `/dashboard/[tenantId]` | session + owner | overview + PIN generator |
| `/dashboard/[tenantId]/providers` | session + owner | list, wire, revoke `integration_tokens` |
| `/dashboard/[tenantId]/agents` | session + owner | per-tenant `tenant_agents` toggle |
| `/dashboard/[tenantId]/senders` | session + owner | list, revoke `identity_bindings` |
| `/dashboard/[tenantId]/usage` | session + owner | placeholder (see `observability.md`) |
| `/api/proxy/[...path]` | passthrough | forwards Cookie + body to middleware over MIDDLEWARE binding |

## Auth model

`layouts/Dashboard.astro` gates every `/dashboard/*` page:

1. If `RUBOT_DATA_AUTH=open`, render a "bearer mode required" banner and stop.
2. Else fetch `/api/proxy/auth/me`. 401 → redirect to `/login`.
3. Else if the session resolves but `approved=0`, render the **Pending approval** card (account exists, but a super-admin hasn't activated it yet). Tenant routes return 403 `not_approved`.
4. Else render the page with the manager email in the topbar.

`/api/tenant/*` endpoints additionally check `requireApprovedManager → isManagerOwnerOf(manager_id, tenantId)` on the middleware side — page-level UI gating is convenience, not the security boundary.

## Role model

| Flag | Meaning |
|---|---|
| `email_confirmed=0` | post-register, waiting on confirmation link |
| `email_confirmed=1, approved=0` | post-confirm, awaiting super-admin |
| `approved=1` | full dashboard access |
| `is_superadmin=1` | additionally able to log into `rubot-superadmin` and call `/api/admin/*` |

Super-admin management lives in a separate worker (`rubot-superadmin`),
documented in `docs/superadmin.md`. The bootstrap super-admin comes from
the middleware env var `SUPERADMIN_EMAIL`.

## Env / bindings

| Name | Where | Required | Purpose |
|---|---|---|---|
| `MIDDLEWARE` | wrangler `services` | yes | Service Binding to `rubot-middleware`. |
| `RUBOT_DATA_AUTH` | wrangler `vars` | yes (`bearer`) | Must match middleware. When `open`, the dashboard refuses to render anything except the banner. |

No secrets live in `rubot-client` itself.

## Local dev

```bash
# terminal A: middleware
cd workers/rubot-middleware
npx wrangler dev --port 8788

# terminal B: rubot-client
cd workers/rubot-client
npx wrangler dev --port 8788
```

On Workers, Service Bindings work across local `wrangler dev` processes
when both are started with `--local` and bound through the same wrangler
session. For the simplest path during development, hit the middleware
directly through its public URL by swapping the MIDDLEWARE binding for
an `MIDDLEWARE_PUBLIC_BASE_URL` var + a `fetch()` to that URL in
`lib/middleware.ts`.

## What's not in v1

- OAuth start flow for providers (paste-API-key only for now).
- Per-tenant agent enable bulk operations (one toggle per row).
- Real usage page (see `observability.md`).
- `rubot-open-client` build-out (only stock Astro shell exists; future work).
