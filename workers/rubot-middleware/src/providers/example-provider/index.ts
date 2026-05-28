/**
 * example-provider — single illustrative provider stub.
 *
 * Real deployments add one directory under `src/providers/` per
 * connected system. This file shows the shape: a Hono sub-app that
 * exposes `/data/:tenantId/...` routes which the middleware's data-auth
 * guard has already validated. Replace the sample-data handler with a
 * real OAuth-bearer-protected upstream fetch or DB query.
 *
 * Patterns to follow when porting a real source:
 *
 *  ┌────────────────────────────────────────────────────────────────┐
 *  │ OAuth + HTTP (e.g. CRM/ERP/external SaaS)                      │
 *  │   1. Load access_token from integration_tokens (tenant,prov).  │
 *  │   2. If expires_at <= now and auto_renew=1, call               │
 *  │      refreshProviderToken() — provider-specific token endpoint.│
 *  │   3. fetch(upstreamUrl, { Authorization: `Bearer ${token}` }). │
 *  │   4. Forward JSON to the caller; map upstream 4xx/5xx → 502.   │
 *  └────────────────────────────────────────────────────────────────┘
 *
 *  ┌────────────────────────────────────────────────────────────────┐
 *  │ SQL warehouse (e.g. JDBC / BigQuery / Postgres / etc.)         │
 *  │   1. Load tenant's credential blob from a dedicated table      │
 *  │      (e.g. `<provider>_credentials`).                          │
 *  │   2. Mint a short-lived JWT / session token if applicable.     │
 *  │   3. Execute a parameterized query via the SQL API.            │
 *  │   4. Stream rows back as JSON (keep results bounded).          │
 *  └────────────────────────────────────────────────────────────────┘
 */

import { Hono } from "hono";
import type { AppContext } from "../../routes/internal";

const exampleProviderApp = new Hono<AppContext>();

/**
 * GET /api/example-provider/data/:tenantId/sample
 *
 * Returns a tiny canned payload so the orchestrator can verify the
 * end-to-end gateway → middleware → provider path before a real
 * upstream is wired in.
 */
exampleProviderApp.get("/data/:tenantId/sample", (c) => {
  const tenantId = c.req.param("tenantId");
  return c.json({
    success: true,
    data: {
      tenant_id: tenantId,
      provider: "example-provider",
      items: [
        { id: "sample-1", label: "Example item 1" },
        { id: "sample-2", label: "Example item 2" },
      ],
    },
  });
});

/**
 * GET /api/example-provider/data/:tenantId/echo
 *
 * Demonstrates returning the resolved tenant_id alongside any caller
 * query string, useful for early integration tests.
 */
exampleProviderApp.get("/data/:tenantId/echo", (c) => {
  const tenantId = c.req.param("tenantId");
  const url = new URL(c.req.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  return c.json({
    success: true,
    data: { tenant_id: tenantId, provider: "example-provider", query: params },
  });
});

export default exampleProviderApp;
