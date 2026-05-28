/**
 * /api/tenant/* — manager dashboard administration.
 *
 * Mounted only when `RUBOT_DATA_AUTH=bearer` (gated alongside /api/auth
 * and /api/provision in src/index.ts). Every endpoint:
 *   1. Resolves manager_id via the rubot_session HMAC cookie.
 *   2. When tenant-scoped, calls isManagerOwnerOf(manager_id, tenantId).
 *
 * Endpoints:
 *   GET    /api/tenant                                    — list owned tenants
 *   POST   /api/tenant                                    — create tenant + return one-time secret
 *   GET    /api/tenant/:tenantId/integrations             — list integration_tokens (token masked)
 *   POST   /api/tenant/:tenantId/integrations/:provider   — wire/upsert
 *   DELETE /api/tenant/:tenantId/integrations/:provider   — revoke
 *   GET    /api/tenant/:tenantId/agents                   — registry × tenant_agents
 *   POST   /api/tenant/:tenantId/agents/:agentId/toggle   — flip enabled
 *   GET    /api/tenant/:tenantId/senders                  — list identity_bindings
 *   DELETE /api/tenant/:tenantId/senders/:senderId        — revoke binding
 *   GET    /api/tenant/:tenantId/usage                    — placeholder
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext, ManagerRow } from "../types";
import { requireApprovedManager } from "../utils/session";
import {
  isManagerOwnerOf,
  linkManagerTenant,
  listManagerTenants,
} from "../utils/manager";
import { hashSecret } from "../utils/tenant-auth";
import { SENDER_ID_RX, TENANT_ID_RX } from "../utils/validate";

const tenantApp = new Hono<AppContext>();

const AGENT_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_RX = /^[A-Za-z0-9_-]{1,64}$/;

async function parseJson<T = unknown>(c: Context<AppContext>): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function ok<T>(c: Context<AppContext>, data: T, status = 200) {
  return c.json({ success: true, data }, status as 200);
}
function fail(c: Context<AppContext>, error: string, status = 400) {
  return c.json({ success: false, error }, status as 400);
}

/**
 * Composite guard: session → approved manager → tenant ownership. On
 * failure, returns a JSON Response the caller forwards as-is.
 *
 * - 401 unauthorized — bad/missing session.
 * - 403 not_approved — manager exists but approved=0 (pending or revoked).
 * - 400 invalid_tenant_id — malformed segment.
 * - 403 forbidden — manager doesn't own this tenant.
 */
async function ownedTenant(
  c: Context<AppContext>,
  tenantId: string,
): Promise<ManagerRow | Response> {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;
  if (!TENANT_ID_RX.test(tenantId)) return fail(c, "invalid_tenant_id", 400);
  if (!(await isManagerOwnerOf(c.env.DB, guard.manager_id, tenantId))) {
    return fail(c, "forbidden", 403);
  }
  return guard;
}

function generateTenantSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function knownAgentIds(env: AppContext["Bindings"]): string[] {
  const raw = (env.KNOWN_AGENTS_JSON ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => typeof v === "string" && AGENT_ID_RX.test(v),
    );
  } catch {
    return [];
  }
}

// ── tenant list + create ────────────────────────────────────────

tenantApp.get("/", async (c) => {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;
  const tenants = await listManagerTenants(c.env.DB, guard.manager_id);
  return ok(c, { tenants });
});

interface CreateTenantBody {
  tenant_id?: string;
  name?: string | null;
}

tenantApp.post("/", async (c) => {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;

  const body = await parseJson<CreateTenantBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const tenantId = (body.tenant_id || "").trim();
  if (!TENANT_ID_RX.test(tenantId)) return fail(c, "invalid_tenant_id", 400);

  const existing = await c.env.DB
    .prepare("SELECT tenant_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  if (existing) return fail(c, "tenant_already_exists", 409);

  const plainSecret = generateTenantSecret();
  const secretHash = await hashSecret(plainSecret);
  const name = body.name?.trim() || null;

  await c.env.DB
    .prepare(
      "INSERT INTO tenants (tenant_id, secret_hash, name) VALUES (?, ?, ?)",
    )
    .bind(tenantId, secretHash, name)
    .run();

  await linkManagerTenant(c.env.DB, guard.manager_id, tenantId);

  // Plaintext secret is shown ONCE here; manager must store it. We
  // don't keep it server-side beyond the SHA-256 hash.
  return ok(c, { tenant_id: tenantId, name, secret: plainSecret });
});

// ── integrations ────────────────────────────────────────────────

interface IntegrationListEntry {
  provider: string;
  has_access_token: boolean;
  has_refresh_token: boolean;
  expires_at: number;
  auto_renew: number;
  updated_at: number;
}

tenantApp.get("/:tenantId/integrations", async (c) => {
  const tenantId = c.req.param("tenantId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  const { results } = await c.env.DB
    .prepare(
      `SELECT provider, access_token, refresh_token, expires_at, auto_renew, updated_at
       FROM integration_tokens
       WHERE tenant_id = ?
       ORDER BY provider ASC`,
    )
    .bind(tenantId)
    .all<{
      provider: string;
      access_token: string | null;
      refresh_token: string | null;
      expires_at: number;
      auto_renew: number;
      updated_at: number;
    }>();

  const integrations: IntegrationListEntry[] = results.map((r) => ({
    provider: r.provider,
    has_access_token: !!r.access_token,
    has_refresh_token: !!r.refresh_token,
    expires_at: r.expires_at,
    auto_renew: r.auto_renew,
    updated_at: r.updated_at,
  }));

  return ok(c, { integrations });
});

interface UpsertIntegrationBody {
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: number;
  auto_renew?: boolean;
}

tenantApp.post("/:tenantId/integrations/:provider", async (c) => {
  const tenantId = c.req.param("tenantId");
  const provider = c.req.param("provider");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  if (!PROVIDER_RX.test(provider)) return fail(c, "invalid_provider", 400);

  const body = await parseJson<UpsertIntegrationBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const access = (body.access_token || "").trim();
  if (!access) return fail(c, "missing_access_token", 400);

  const refresh = body.refresh_token == null ? null : String(body.refresh_token);
  const expires = Number.isFinite(body.expires_at) ? Number(body.expires_at) : 0;
  const autoRenew = body.auto_renew ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB
    .prepare(
      `INSERT INTO integration_tokens
         (tenant_id, provider, access_token, refresh_token, expires_at, auto_renew, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, provider) DO UPDATE SET
         access_token  = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at    = excluded.expires_at,
         auto_renew    = excluded.auto_renew,
         updated_at    = excluded.updated_at`,
    )
    .bind(tenantId, provider, access, refresh, expires, autoRenew, now)
    .run();

  return ok(c, {
    provider,
    expires_at: expires,
    auto_renew: autoRenew,
    updated_at: now,
  });
});

tenantApp.delete("/:tenantId/integrations/:provider", async (c) => {
  const tenantId = c.req.param("tenantId");
  const provider = c.req.param("provider");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  if (!PROVIDER_RX.test(provider)) return fail(c, "invalid_provider", 400);

  await c.env.DB
    .prepare(
      "DELETE FROM integration_tokens WHERE tenant_id = ? AND provider = ?",
    )
    .bind(tenantId, provider)
    .run();

  return ok(c, { revoked: true, provider });
});

// ── agents ──────────────────────────────────────────────────────

interface AgentListEntry {
  agent_id: string;
  enabled: boolean;
}

tenantApp.get("/:tenantId/agents", async (c) => {
  const tenantId = c.req.param("tenantId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  const known = knownAgentIds(c.env);
  if (known.length === 0) return ok(c, { agents: [] as AgentListEntry[] });

  const { results } = await c.env.DB
    .prepare(
      "SELECT agent_id, enabled FROM tenant_agents WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .all<{ agent_id: string; enabled: number }>();
  const overrides = new Map<string, boolean>(
    results.map((r) => [r.agent_id, r.enabled === 1]),
  );

  const agents: AgentListEntry[] = known.map((agent_id) => ({
    agent_id,
    enabled: overrides.get(agent_id) ?? true,
  }));

  return ok(c, { agents });
});

interface ToggleAgentBody {
  enabled?: boolean;
}

tenantApp.post("/:tenantId/agents/:agentId/toggle", async (c) => {
  const tenantId = c.req.param("tenantId");
  const agentId = c.req.param("agentId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  if (!AGENT_ID_RX.test(agentId)) return fail(c, "invalid_agent_id", 400);

  const known = knownAgentIds(c.env);
  if (known.length > 0 && !known.includes(agentId)) {
    return fail(c, "unknown_agent_id", 404);
  }

  const body = await parseJson<ToggleAgentBody>(c);
  if (!body || typeof body.enabled !== "boolean") {
    return fail(c, "invalid_json", 400);
  }

  const enabled = body.enabled ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB
    .prepare(
      `INSERT INTO tenant_agents (tenant_id, agent_id, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
         enabled    = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .bind(tenantId, agentId, enabled, now)
    .run();

  return ok(c, { agent_id: agentId, enabled: enabled === 1 });
});

// ── senders ─────────────────────────────────────────────────────

tenantApp.get("/:tenantId/senders", async (c) => {
  const tenantId = c.req.param("tenantId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  const { results } = await c.env.DB
    .prepare(
      `SELECT sender_id, created_at FROM identity_bindings
       WHERE tenant_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(tenantId)
    .all<{ sender_id: string; created_at: number }>();

  return ok(c, { senders: results });
});

tenantApp.delete("/:tenantId/senders/:senderId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const senderId = c.req.param("senderId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  if (!SENDER_ID_RX.test(senderId)) return fail(c, "invalid_sender_id", 400);

  await c.env.DB
    .prepare(
      "DELETE FROM identity_bindings WHERE tenant_id = ? AND sender_id = ?",
    )
    .bind(tenantId, senderId)
    .run();

  return ok(c, { revoked: true, sender_id: senderId });
});

// ── usage (placeholder) ─────────────────────────────────────────

tenantApp.get("/:tenantId/usage", async (c) => {
  const tenantId = c.req.param("tenantId");
  const guard = await ownedTenant(c, tenantId);
  if (guard instanceof Response) return guard;

  return ok(c, {
    enabled: false,
    reason: "log_sink_not_wired",
    docs: "/docs/observability.md",
    tenant_id: tenantId,
  });
});

export default tenantApp;
