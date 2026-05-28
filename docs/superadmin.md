# Super-admin (`rubot-superadmin`)

Manages dashboard access across both rubot-client (bearer mode) and
rubot-open-client (open mode). Single source of truth — the
`managers.is_superadmin` flag, scoped to no tenant.

## Account states

```
register
   │
   ▼
email_confirmed=0 ──confirm-email──▶ email_confirmed=1, approved=0
                                              │
                                              ▼
                                    approved=1 (super-admin click)
                                              │
                              ┌───────────────┴──────────────┐
                              ▼                              ▼
                          normal manager              is_superadmin=1
```

The bootstrap super-admin (env `SUPERADMIN_EMAIL`) skips both gates —
on register the row is inserted with `email_confirmed=1, approved=1,
is_superadmin=1`.

## Bootstrap

Set in `rubot-middleware`'s `wrangler.jsonc`:

```jsonc
"vars": {
  "SUPERADMIN_EMAIL": "you@example.com"
}
```

Then register on any dashboard (`rubot-client`, `rubot-open-client`, or
`rubot-superadmin` itself) using that email. The response payload comes
back as `{ pending_confirmation: false, bootstrapped: true }` and you can
sign in immediately.

If `SUPERADMIN_EMAIL` is unset, promote a row by hand:

```bash
wrangler d1 execute rubot_data --local --command "\
UPDATE managers SET email_confirmed=1, approved=1, is_superadmin=1 \
WHERE email='you@example.com';"
```

## Routes (always mounted, both modes)

| Method + path | Op |
|---|---|
| `GET /api/admin/managers?status=pending|approved|all` | list |
| `POST /api/admin/managers/:id/approve` | flip approved=1 |
| `POST /api/admin/managers/:id/revoke` | flip approved=0 (with optional `reason`) |
| `POST /api/admin/managers/:id/superadmin` | `{grant: bool}` |
| `GET /api/admin/managers/:id/audit` | audit trail for one manager |
| `GET /api/admin/logs` | placeholder (see `observability.md`) |
| `GET /api/admin/agent-logs` | placeholder |

All gated by: `requireApprovedManager → is_superadmin === 1`.

## Audit

Every state change writes to `account_audit(manager_id, actor_id,
action, reason, created_at)`. `actor_id` is NULL for the bootstrap
insert (`action='bootstrap'`).

## Dashboard

Routes on `rubot-superadmin`:

| Path | Purpose |
|---|---|
| `/` | redirect → `/admin` (logged in) or `/login` |
| `/login` | POST `/api/proxy/auth/login` |
| `/admin` | manager list (pending/approved/all tabs) + actions |
| `/admin/logs` | placeholder |
| `/admin/agent-logs` | placeholder |
| `/api/proxy/[...path]` | cookie-forwarder to middleware |

The `SuperAdmin.astro` layout gates every `/admin/*` page on session +
`is_superadmin=1 && approved=1`. Non-super-admins hitting the URL see a
403 banner with a link back to the operator dashboards.

## Eventual log integration

The two placeholder pages (`/admin/logs`, `/admin/agent-logs`) wait on a
log sink (`docs/observability.md`). The pattern is the same one used by
`tenant.usage`: pick a sink, add a middleware endpoint that queries it,
swap the placeholder for a fetch + table. Trace IDs are already
end-to-end so the backfill is a SELECT.
