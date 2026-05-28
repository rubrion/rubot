/**
 * /api/internal/* — service-to-service endpoints called by rubot-gateway
 * (via Cloudflare Service Binding) using `Authorization: Bearer
 * MIDDLEWARE_API_KEY`. Never exposed to the public.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { mintBearer } from "../utils/minted-bearer";
import { SENDER_ID_RX, SESSION_ID_RX, TENANT_ID_RX } from "../utils/validate";
import type { AppContext } from "../types";

// Re-export for back-compat with files that previously imported the
// Bindings/AppContext types from this route module.
export type { Bindings, AppContext } from "../types";

const internalApp = new Hono<AppContext>();

const BIND_DEFAULT_TTL_SEC = 60 * 15; // 15 min — covers continuation turns
const BIND_MIN_TTL_SEC = 60;
const BIND_MAX_TTL_SEC = 60 * 60; // 1h cap

function requireServiceKey(c: Context<AppContext>): boolean {
  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!c.env.MIDDLEWARE_API_KEY && bearer === c.env.MIDDLEWARE_API_KEY;
}

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

async function lookupTenantBySender(
  db: D1Database,
  senderId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT tenant_id FROM identity_bindings WHERE sender_id = ?")
    .bind(senderId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

interface BindSessionBody {
  session_id?: string;
  tenant_id?: string;
  sender_id?: string;
  ttl_sec?: number;
}

/**
 * POST /api/internal/bind-session
 * Auth: Bearer MIDDLEWARE_API_KEY
 *
 * Called by rubot-gateway on the first turn of a chat session. Accepts
 * either an already-resolved tenant_id OR a sender_id (which is looked
 * up in identity_bindings to find the owning tenant). Mints a short
 * bearer scoped to that tenant_id and UPSERTs the row keyed on
 * session_id. Subsequent turns reuse the same bearer until it expires;
 * /refresh-bearer remints in place.
 */
internalApp.post("/bind-session", async (c) => {
  if (!requireServiceKey(c)) return fail(c, "unauthorized", 401);

  const body = await parseJson<BindSessionBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const sessionId = (body.session_id || "").trim();
  if (!sessionId || !SESSION_ID_RX.test(sessionId)) {
    return fail(c, "invalid_session_id", 400);
  }

  let tenantId = (body.tenant_id || "").trim();
  const senderId = (body.sender_id || "").trim();

  if (!tenantId) {
    if (!senderId || !SENDER_ID_RX.test(senderId)) {
      return fail(c, "missing_tenant_id_or_sender_id", 400);
    }
    const resolved = await lookupTenantBySender(c.env.DB, senderId);
    if (!resolved) return fail(c, "sender_not_linked", 404);
    tenantId = resolved;
  }

  if (!TENANT_ID_RX.test(tenantId)) return fail(c, "invalid_tenant_id", 400);

  const ttlSec =
    typeof body.ttl_sec === "number" ? body.ttl_sec : BIND_DEFAULT_TTL_SEC;
  if (
    !Number.isFinite(ttlSec) ||
    ttlSec < BIND_MIN_TTL_SEC ||
    ttlSec > BIND_MAX_TTL_SEC
  ) {
    return fail(c, "ttl_out_of_range", 400);
  }

  const { token, exp } = await mintBearer(
    tenantId,
    c.env.BEARER_SIGNING_SECRET,
    ttlSec,
  );
  const now = Math.floor(Date.now() / 1000);
  const senderForRow = senderId || null;

  await c.env.DB
    .prepare(
      `INSERT INTO session_bearers (session_id, tenant_id, bearer, expires_at, updated_at, sender_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         tenant_id  = excluded.tenant_id,
         bearer     = excluded.bearer,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at,
         sender_id  = COALESCE(excluded.sender_id, session_bearers.sender_id)`,
    )
    .bind(sessionId, tenantId, token, exp, now, senderForRow)
    .run();

  return ok(c, {
    session_id: sessionId,
    tenant_id: tenantId,
    expires_at: exp,
  });
});

interface RefreshBearerBody {
  session_id?: string;
  ttl_sec?: number;
}

/**
 * POST /api/internal/refresh-bearer
 * Auth: Bearer MIDDLEWARE_API_KEY
 *
 * Called by rubot-gateway when an existing session_bearers row is found
 * but its bearer has expired. Re-mints in place using the row's
 * tenant_id (no sender lookup) so the gateway can self-heal across
 * worker cold-starts without ever holding BEARER_SIGNING_SECRET.
 */
internalApp.post("/refresh-bearer", async (c) => {
  if (!requireServiceKey(c)) return fail(c, "unauthorized", 401);

  const body = await parseJson<RefreshBearerBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const sessionId = (body.session_id || "").trim();
  if (!sessionId || !SESSION_ID_RX.test(sessionId)) {
    return fail(c, "invalid_session_id", 400);
  }

  const ttlSec =
    typeof body.ttl_sec === "number" ? body.ttl_sec : BIND_DEFAULT_TTL_SEC;
  if (
    !Number.isFinite(ttlSec) ||
    ttlSec < BIND_MIN_TTL_SEC ||
    ttlSec > BIND_MAX_TTL_SEC
  ) {
    return fail(c, "ttl_out_of_range", 400);
  }

  const row = await c.env.DB
    .prepare(`SELECT tenant_id FROM session_bearers WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ tenant_id: string }>();
  if (!row) return fail(c, "session_not_bound", 404);
  if (!TENANT_ID_RX.test(row.tenant_id)) return fail(c, "invalid_tenant_id", 500);

  const { token, exp } = await mintBearer(
    row.tenant_id,
    c.env.BEARER_SIGNING_SECRET,
    ttlSec,
  );
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `UPDATE session_bearers
         SET bearer = ?, expires_at = ?, updated_at = ?
       WHERE session_id = ?`,
    )
    .bind(token, exp, now, sessionId)
    .run();

  return ok(c, {
    session_id: sessionId,
    tenant_id: row.tenant_id,
    bearer: token,
    expires_at: exp,
  });
});

export default internalApp;
