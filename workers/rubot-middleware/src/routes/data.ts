/**
 * Data preflight — what providers does this tenant have connected, and
 * which registered agents are enabled for it?
 *
 * The orchestrator calls GET /api/data/:tenantId/connections at the
 * start of a turn to discover both:
 *   - `connections[*].provider` — which provider sub-app under
 *     /api/<provider>/data/:tenantId/* it can route to.
 *   - `agents[*].agent_id` — which specialist agents the tenant has
 *     enabled (per-tenant toggle from the dashboard, default ON).
 *
 * The `connections` shape MUST stay stable for back-compat. `agents` is
 * additive — preflight callers that ignore it behave as before.
 */

import { Hono } from "hono";
import type { AppContext, Bindings } from "../types";
import { fetchTokensForTenant } from "../utils/token-service";

const dataApp = new Hono<AppContext>();

interface ConnectionEntry {
  provider: string;
  connected: boolean;
  expired: boolean;
  expires_at?: number;
}

interface AgentEntry {
  agent_id: string;
  enabled: boolean;
}

const AGENT_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;

function knownAgentIds(env: Bindings): string[] {
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

async function tenantAgentOverrides(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, boolean>> {
  const { results } = await db
    .prepare(
      "SELECT agent_id, enabled FROM tenant_agents WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .all<{ agent_id: string; enabled: number }>();
  return new Map(results.map((r) => [r.agent_id, r.enabled === 1]));
}

dataApp.get("/:tenantId/connections", async (c) => {
  const tenantId = c.req.param("tenantId");
  const now = Math.floor(Date.now() / 1000);

  // Static list of providers wired into this worker. Add an entry here
  // when porting a new provider (and mount its sub-app under
  // /api/<provider>/ in src/index.ts).
  const KNOWN_PROVIDERS = ["example-provider"] as const;
  const known = knownAgentIds(c.env);

  if ((c.env.RUBOT_DATA_AUTH || "bearer") === "open") {
    const connections = KNOWN_PROVIDERS.map((provider) => ({
      provider,
      connected: true,
      expired: false,
    }));
    const agents: AgentEntry[] = known.map((agent_id) => ({
      agent_id,
      enabled: true,
    }));
    return c.json({ connections, agents });
  }

  const tokens = await fetchTokensForTenant(c.env.DB, tenantId);

  const connections: ConnectionEntry[] = KNOWN_PROVIDERS.map((provider) => {
    const token = tokens.find((t) => t.provider === provider);
    if (!token) {
      return { provider, connected: false, expired: false };
    }
    return {
      provider,
      connected: true,
      expired: token.expires_at > 0 && token.expires_at <= now,
      expires_at: token.expires_at,
    };
  });

  const overrides = await tenantAgentOverrides(c.env.DB, tenantId);
  const agents: AgentEntry[] = known.map((agent_id) => ({
    agent_id,
    enabled: overrides.get(agent_id) ?? true,
  }));

  return c.json({ connections, agents });
});

export default dataApp;
