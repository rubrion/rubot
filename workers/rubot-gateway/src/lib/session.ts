/**
 * Session bearer resolver.
 *
 * Resolves a chat-source session id (minted by the upstream chat-source
 * adapter) to a short-lived per-tenant bearer that downstream services
 * (orchestrator, middleware, data routes) use as the auth boundary.
 *
 * Self-healing layers (in order):
 *   1. Row present, bearer valid               → use it (D1 cache hit).
 *   2. Row present, bearer expired             → refreshSessionBearer (re-mint).
 *   3. Row missing, sender id header present   → bindSessionFromSender.
 *
 * Returns null when no row exists AND no sender id was stamped, OR the
 * middleware rejected the bind/refresh.
 *
 * NOTE: the bodies of lookup/refresh/bind below keep the D1 + service-binding
 *       shape from the source worker but the tenant-resolution logic is
 *       deliberately abstracted. Real wire-up (per-deployment identity rules,
 *       sender-allowlist, etc.) is downstream user work — see TODO comments.
 */

// TTL the gateway requests when asking the middleware to re-mint an expired
// bearer. Matches the 15-min cap on minted bearers.
export const REMINT_TTL_SEC = 60 * 15;

export interface SessionBinding {
  bearer: string;
  tenantId: string;
}

interface SessionBearerRow {
  tenant_id: string;
  bearer: string;
  expires_at: number;
}

/**
 * Ask the middleware to re-mint the bearer for a session whose stored row is
 * expired. The middleware is the sole canonical signer in the deployed
 * topology — the gateway proxies the re-mint request and re-reads the row
 * (in production) or accepts the bearer in the response envelope.
 */
export async function refreshSessionBearer(
  middleware: Fetcher,
  apiKey: string,
  sessionId: string,
): Promise<SessionBinding | null> {
  if (!apiKey) {
    console.log(`[gateway] refresh-bearer skipped session_id="${sessionId}" reason=no_api_key`);
    return null;
  }
  let resp: Response;
  try {
    resp = await middleware.fetch("https://internal/api/internal/refresh-bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ session_id: sessionId, ttl_sec: REMINT_TTL_SEC }),
    });
  } catch (err) {
    console.log(
      `[gateway] refresh-bearer threw session_id="${sessionId}" err="${err instanceof Error ? err.message : String(err)}"`,
    );
    return null;
  }
  if (!resp.ok) {
    console.log(`[gateway] refresh-bearer non-ok session_id="${sessionId}" status=${resp.status}`);
    return null;
  }
  const envelope = (await resp.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { bearer?: string; tenant_id?: string };
  } | null;
  if (!envelope?.success) {
    console.log(
      `[gateway] refresh-bearer envelope-fail session_id="${sessionId}" error="${envelope?.error ?? "?"}"`,
    );
    return null;
  }
  const bearer = envelope.data?.bearer;
  const tenantId = envelope.data?.tenant_id;
  if (typeof bearer !== "string" || typeof tenantId !== "string") return null;
  console.log(
    `[gateway] refresh-bearer ok session_id="${sessionId}" tenant_id="${tenantId}"`,
  );
  return { bearer, tenantId };
}

/**
 * Ask the middleware to bind a session_id to its sender-resolved tenant.
 *
 * Used when the gateway sees a session_id with no D1 row but the chat-source
 * adapter has stamped a trusted sender id on the request.
 *
 * TODO: implement sender allowlist if needed — the source worker had a
 *       Brazilian-phone-specific filter; intentionally stripped here.
 */
export async function bindSessionFromSender(
  middleware: Fetcher,
  apiKey: string,
  sessionId: string,
  senderId: string,
): Promise<{ tenantId: string } | null> {
  if (!apiKey) {
    console.log(`[gateway] bind-session skipped session_id="${sessionId}" reason=no_api_key`);
    return null;
  }
  let resp: Response;
  try {
    resp = await middleware.fetch("https://internal/api/internal/bind-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        sender_id: senderId,
        ttl_sec: REMINT_TTL_SEC,
      }),
    });
  } catch (err) {
    console.log(
      `[gateway] bind-session threw session_id="${sessionId}" err="${err instanceof Error ? err.message : String(err)}"`,
    );
    return null;
  }
  if (!resp.ok) {
    console.log(`[gateway] bind-session non-ok session_id="${sessionId}" status=${resp.status}`);
    return null;
  }
  const envelope = (await resp.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { tenant_id?: string };
  } | null;
  if (!envelope?.success) {
    console.log(
      `[gateway] bind-session envelope-fail session_id="${sessionId}" error="${envelope?.error ?? "?"}"`,
    );
    return null;
  }
  const tenantId = envelope.data?.tenant_id;
  if (typeof tenantId !== "string") return null;
  console.log(
    `[gateway] bind-session ok session_id="${sessionId}" tenant_id="${tenantId}"`,
  );
  return { tenantId };
}

/**
 * Resolve session_id (+ optional sender_id) → { bearer, tenantId }.
 *
 * Happy-path placeholder: when `staticBearer` and `staticTenant` are set
 * (e.g. STAGING_STATIC_BEARER / STAGING_STATIC_TENANT in a `staging-test`
 * environment), short-circuit the D1 + middleware dance and return them
 * directly. This is the only resolution path that works out of the box —
 * real per-tenant lookup logic is downstream user work.
 *
 * TODO: populate `session_bearers` via the middleware's bind-session route
 *       and stamp tenant from your actual identity store (the source
 *       worker used a `phone_users` table; intentionally generic here).
 */
export async function lookupSessionBearer(
  db: D1Database,
  sessionId: string,
  middleware: Fetcher,
  apiKey: string,
  senderId: string,
  staticBearer: string,
  staticTenant: string,
): Promise<SessionBinding | null> {
  // Happy-path: static bearer/tenant for `staging-test`-style fixtures.
  if (staticBearer && staticTenant) {
    return { bearer: staticBearer, tenantId: staticTenant };
  }

  const row = await db
    .prepare(
      `SELECT tenant_id, bearer, expires_at FROM session_bearers WHERE session_id = ?`,
    )
    .bind(sessionId)
    .first<SessionBearerRow>();

  if (row) {
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at > now) {
      return { bearer: row.bearer, tenantId: row.tenant_id };
    }
    return refreshSessionBearer(middleware, apiKey, sessionId);
  }

  if (!senderId) return null;
  const bound = await bindSessionFromSender(middleware, apiKey, sessionId, senderId);
  if (!bound) return null;
  // bind-session does not return the bearer; re-read the freshly-written row
  // to pick up the minted token.
  const fresh = await db
    .prepare(
      `SELECT tenant_id, bearer, expires_at FROM session_bearers WHERE session_id = ?`,
    )
    .bind(sessionId)
    .first<SessionBearerRow>();
  if (!fresh) return null;
  return { bearer: fresh.bearer, tenantId: fresh.tenant_id };
}
