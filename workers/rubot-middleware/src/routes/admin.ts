/**
 * /api/admin/* — super-admin only.
 *
 * Mounted in BOTH bearer and open modes (the super-admin role is on the
 * managers row, not gated by RUBOT_DATA_AUTH). Every endpoint:
 *   1. requireApprovedManager → must return a row.
 *   2. row.is_superadmin === 1.
 *
 * Endpoints:
 *   GET    /api/admin/managers[?status=pending|approved|all]
 *   POST   /api/admin/managers/:id/approve
 *   POST   /api/admin/managers/:id/revoke           { reason?: string }
 *   POST   /api/admin/managers/:id/superadmin       { grant: boolean }
 *   GET    /api/admin/managers/:id/audit            — list audit trail
 *   GET    /api/admin/logs                          — placeholder
 *   GET    /api/admin/agent-logs                    — placeholder
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext, ManagerRow } from "../types";
import { requireApprovedManager } from "../utils/session";
import {
  approveManager,
  getManagerById,
  listAccountAudit,
  listManagers,
  revokeManager,
  setSuperadmin,
  type ManagerListFilter,
} from "../utils/manager";

const adminApp = new Hono<AppContext>();

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

async function requireSuperadmin(
  c: Context<AppContext>,
): Promise<ManagerRow | Response> {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;
  if (guard.is_superadmin !== 1) {
    return c.json({ success: false, error: "not_superadmin" }, 403);
  }
  return guard;
}

// ── manager list + state changes ────────────────────────────────

adminApp.get("/managers", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;

  const status = (c.req.query("status") ?? "all").toLowerCase();
  if (status !== "pending" && status !== "approved" && status !== "all") {
    return fail(c, "invalid_status", 400);
  }
  const managers = await listManagers(c.env.DB, status as ManagerListFilter);
  return ok(c, { managers });
});

interface RevokeBody {
  reason?: string | null;
}
interface SuperadminBody {
  grant?: boolean;
}

adminApp.post("/managers/:id/approve", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;

  const targetId = c.req.param("id");
  const target = await getManagerById(c.env.DB, targetId);
  if (!target) return fail(c, "manager_not_found", 404);

  const updated = await approveManager(c.env.DB, targetId, guard.manager_id);
  if (!updated) return fail(c, "approve_failed", 500);
  return ok(c, {
    manager_id: updated.manager_id,
    approved: updated.approved === 1,
  });
});

adminApp.post("/managers/:id/revoke", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;

  const targetId = c.req.param("id");
  const target = await getManagerById(c.env.DB, targetId);
  if (!target) return fail(c, "manager_not_found", 404);
  if (target.manager_id === guard.manager_id) {
    return fail(c, "cannot_revoke_self", 400);
  }

  const body = await parseJson<RevokeBody>(c);
  const reason = body?.reason ? String(body.reason).slice(0, 500) : null;

  const updated = await revokeManager(c.env.DB, targetId, guard.manager_id, reason);
  if (!updated) return fail(c, "revoke_failed", 500);
  return ok(c, {
    manager_id: updated.manager_id,
    approved: updated.approved === 1,
  });
});

adminApp.post("/managers/:id/superadmin", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;

  const targetId = c.req.param("id");
  const target = await getManagerById(c.env.DB, targetId);
  if (!target) return fail(c, "manager_not_found", 404);

  const body = await parseJson<SuperadminBody>(c);
  if (!body || typeof body.grant !== "boolean") {
    return fail(c, "invalid_json", 400);
  }

  // Guard against the last super-admin demoting themselves into a state
  // where no SA exists.
  if (!body.grant && target.manager_id === guard.manager_id) {
    return fail(c, "cannot_demote_self", 400);
  }

  const updated = await setSuperadmin(
    c.env.DB,
    targetId,
    body.grant,
    guard.manager_id,
  );
  if (!updated) return fail(c, "superadmin_update_failed", 500);
  return ok(c, {
    manager_id: updated.manager_id,
    is_superadmin: updated.is_superadmin === 1,
  });
});

adminApp.get("/managers/:id/audit", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;

  const targetId = c.req.param("id");
  const target = await getManagerById(c.env.DB, targetId);
  if (!target) return fail(c, "manager_not_found", 404);

  const events = await listAccountAudit(c.env.DB, targetId);
  return ok(c, { events });
});

// ── observability placeholders ──────────────────────────────────

adminApp.get("/logs", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;
  return ok(c, {
    enabled: false,
    reason: "log_sink_not_wired",
    docs: "/docs/observability.md",
  });
});

adminApp.get("/agent-logs", async (c) => {
  const guard = await requireSuperadmin(c);
  if (guard instanceof Response) return guard;
  return ok(c, {
    enabled: false,
    reason: "log_sink_not_wired",
    docs: "/docs/observability.md",
  });
});

export default adminApp;
