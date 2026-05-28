/**
 * rubot-middleware — entry point.
 *
 * Exposed routes (bearer mode):
 *   POST /api/internal/{bind-session, refresh-bearer}
 *   GET  /api/data/:tenantId/connections
 *   GET  /api/example-provider/data/:tenantId/*
 *   POST /api/auth/{register, login, logout, forgot-password, reset-password}
 *   GET  /api/auth/{me, confirm-email}
 *   POST /api/provision/{generate, consume}
 *   GET  /api/provision/pin/:tenantId
 *   GET/POST/DELETE /api/tenant/:tenantId/{integrations,agents,senders,usage}
 *
 * In open mode (`RUBOT_DATA_AUTH=open`), /api/provision/* and
 * /api/tenant/* are short-circuited to 404 and the data-route bearer
 * chain is bypassed. /api/auth/* and /api/admin/* stay mounted in both
 * modes — both dashboards need login, and the super-admin role is on
 * the managers row regardless of mode.
 *
 * Auth model:
 *   - /api/internal/*    — Bearer MIDDLEWARE_API_KEY (Service Binding only).
 *   - /api/data/*, /api/<provider>/data/*  — minted bearer OR long-lived
 *                          per-tenant secret. Skipped in open mode.
 *   - /api/auth/*        — public (register, login, confirm), or
 *                          rubot_session cookie on /me. Always mounted.
 *   - /api/admin/*       — rubot_session cookie + approved=1 +
 *                          is_superadmin=1. Always mounted.
 *   - /api/provision/*   — bearer mode only; approved manager session
 *                          on /generate + /pin, public on /consume.
 *   - /api/tenant/*      — bearer mode only; approved manager session +
 *                          tenant ownership on every endpoint.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { configure, rubotLogging } from "@rubot/logger";

import internalApp from "./routes/internal";
import dataApp from "./routes/data";
import authApp from "./routes/auth";
import provisionApp from "./routes/provision";
import tenantApp from "./routes/tenant";
import adminApp from "./routes/admin";
import exampleProviderApp from "./providers/example-provider";
import type { AppContext, Bindings } from "./types";

import { isMintedBearer, verifyMintedBearer } from "./utils/minted-bearer";
import { verifyTenantSecret } from "./utils/tenant-auth";

const dataAuthMode = (env: Bindings) => env.RUBOT_DATA_AUTH ?? "bearer";

const app = new Hono<AppContext>();

app.use("*", cors());

// Configure the logger once per isolate. Subsequent calls overwrite the
// service-level config — cheap, idempotent.
app.use("*", async (c, next) => {
  configure({
    service: "rubot-middleware",
    environment: c.env.ENVIRONMENT ?? "dev",
    deploymentHash: c.env.RUBOT_DEPLOYMENT_HASH ?? "local",
  });
  return next();
});

app.use("*", rubotLogging());

const apiApp = new Hono<AppContext>();

apiApp.get("/", (c) => {
  const mode = dataAuthMode(c.env);
  return c.json({
    success: true,
    data: {
      name: "rubot-middleware",
      mode,
      routes: {
        internal: [
          "POST /api/internal/bind-session",
          "POST /api/internal/refresh-bearer",
        ],
        data: ["GET /api/data/:tenantId/connections"],
        providers: [
          "GET /api/example-provider/data/:tenantId/sample",
          "GET /api/example-provider/data/:tenantId/echo",
        ],
        // Auth + admin are always reachable (both modes need login;
        // super-admin role lives on the managers row, not in env).
        auth: [
          "POST /api/auth/register",
          "POST /api/auth/login",
          "POST /api/auth/logout",
          "GET  /api/auth/me",
          "GET  /api/auth/confirm-email",
          "POST /api/auth/forgot-password",
          "POST /api/auth/reset-password",
        ],
        admin: [
          "GET    /api/admin/managers",
          "POST   /api/admin/managers/:id/approve",
          "POST   /api/admin/managers/:id/revoke",
          "POST   /api/admin/managers/:id/superadmin",
          "GET    /api/admin/managers/:id/audit",
          "GET    /api/admin/logs",
          "GET    /api/admin/agent-logs",
        ],
        // Provisioning + tenant admin are bearer-mode only.
        ...(mode === "bearer"
          ? {
              provision: [
                "POST /api/provision/generate",
                "GET  /api/provision/pin/:tenantId",
                "POST /api/provision/consume",
              ],
              tenant: [
                "GET    /api/tenant",
                "POST   /api/tenant",
                "GET    /api/tenant/:tenantId/integrations",
                "POST   /api/tenant/:tenantId/integrations/:provider",
                "DELETE /api/tenant/:tenantId/integrations/:provider",
                "GET    /api/tenant/:tenantId/agents",
                "POST   /api/tenant/:tenantId/agents/:agentId/toggle",
                "GET    /api/tenant/:tenantId/senders",
                "DELETE /api/tenant/:tenantId/senders/:senderId",
                "GET    /api/tenant/:tenantId/usage",
              ],
            }
          : {}),
      },
    },
  });
});

/**
 * Shared auth middleware for all data routes (preflight + per-provider).
 *
 * Accepts the request if any of the following authenticates the
 * `:tenantId` segment in the path:
 *   1. A minted bearer (`mbr.v1...`) whose tenant_id matches.
 *   2. `Authorization: Bearer <long-lived-tenant-secret>` matching
 *      `tenants.secret_hash` for the same tenant.
 *
 * Manager session cookies are deliberately NOT accepted here — the
 * dashboard cookie is for human admin endpoints under /api/auth/* and
 * /api/provision/*, not for direct data access. Keeping the two trust
 * domains separated means a stolen cookie can't be used to scrape
 * provider data.
 */
async function dataAuthMiddleware(
  c: Context<AppContext>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");

  const segments = c.req.path.split("/");
  const dataIndex = segments.indexOf("data");
  const tenantId = dataIndex >= 0 ? segments[dataIndex + 1] : undefined;

  if (!tenantId) {
    return c.json({ success: false, error: "missing_tenant_id" }, 400);
  }

  if ((c.env.RUBOT_DATA_AUTH || "bearer") === "open") {
    return next();
  }

  // 1. Minted bearer (preferred for service-to-service calls).
  if (bearer && isMintedBearer(bearer)) {
    const verified = await verifyMintedBearer(bearer, c.env.BEARER_SIGNING_SECRET);
    if (verified && verified.tenantId === tenantId) {
      return next();
    }
    return c.json({ success: false, error: "unauthorized" }, 401);
  }

  // 2. Long-lived per-tenant secret.
  if (bearer) {
    if (await verifyTenantSecret(c.env.DB, tenantId, bearer)) {
      return next();
    }
  }

  return c.json({ success: false, error: "unauthorized" }, 401);
}

// Mount data-auth on every data namespace BEFORE the route handlers.
apiApp.use("/data/*", dataAuthMiddleware);
apiApp.use("/example-provider/data/*", dataAuthMiddleware);

apiApp.route("/internal", internalApp);
apiApp.route("/data", dataApp);
apiApp.route("/example-provider", exampleProviderApp);

// Always-mounted (both modes):
//   /api/auth/*   — both bearer + open dashboards need login + register.
//   /api/admin/*  — super-admin role lives on the managers row, not in
//                    env. The role exists in both modes.
apiApp.route("/auth", authApp);
apiApp.route("/admin", adminApp);

// Tenant admin + PIN provisioning are bearer-mode-only — open mode has
// no tenant-ownership concept, so administering those routes would be
// meaningless. Short-circuit to 404 instead of mounting them.
apiApp.use("/provision/*", async (c, next) => {
  if (dataAuthMode(c.env) === "open") {
    return c.json(
      { success: false, error: "provisioning_disabled_in_open_mode" },
      404,
    );
  }
  return next();
});
apiApp.use("/tenant/*", async (c, next) => {
  if (dataAuthMode(c.env) === "open") {
    return c.json(
      { success: false, error: "tenant_admin_disabled_in_open_mode" },
      404,
    );
  }
  return next();
});

apiApp.route("/provision", provisionApp);
apiApp.route("/tenant", tenantApp);

app.route("/api", apiApp);

app.notFound((c) => c.json({ success: false, error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("rubot-middleware error:", err);
  return c.json({ success: false, error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch.bind(app),
};
