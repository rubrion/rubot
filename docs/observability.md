# Observability

The scaffold ships structured logging (`@rubot/logger` for Python,
`rubotLogging()` middleware for the Hono workers) but **deliberately
omits a log sink**. Pick one of the options below per deploy.

## Log envelope

Every service emits the same JSON shape per event (documented in
`architecture.md → Structured log envelope`). The fields the dashboard
needs:

| Field | Meaning |
|---|---|
| `trace_id` | minted at the gateway, propagated to every hop |
| `tenant_id` | required for per-tenant rollups |
| `service` | `rubot-gateway`, `rubot-middleware`, `rubot-orchestrator`, … |
| `kind` | `chat.turn`, `tool.call`, `middleware.error`, … |
| `latency_ms` | per-hop timing |
| `ts` | unix ms |

## Sink options

| Option | Fit |
|---|---|
| **Cloudflare Logpush** (workers) + R2/S3 + query via DuckDB / Athena | Cheapest for low volume. No extra services. |
| **Datadog Logs** | Hosted, batteries-included dashboarding. Replace `console.log`/`logger.info` with the Datadog client. |
| **OpenTelemetry collector + ClickHouse / Loki** | Self-hosted, full control, more infra to run. |
| **Workers Analytics Engine** | CF-native, no egress, SQL API. Good fit for the Hono workers; less ideal for the Python services on Railway. |

## Wiring the dashboard usage page

`rubot/workers/rubot-client/src/pages/dashboard/[tenantId]/usage.astro`
currently renders a placeholder. To back it with real data:

1. Pick a sink and stand it up.
2. Add a new middleware route, e.g. `GET /api/tenant/:tenantId/usage`,
   that queries the sink and returns
   `{ traces: [...], counts: {...} }`.
3. Swap the placeholder render in `usage.astro` for a fetch + table.

The middleware-side ownership check (`isManagerOwnerOf`) stays in place
— the dashboard never reads usage data directly.

## What about the structured log itself in dev?

`@rubot/logger` and `rubotLogging()` both write to stdout. In
`npx wrangler dev`, that surfaces in the worker log pane. In docker-run
Python services, it surfaces on stderr. Local dev needs nothing more
than a terminal.
