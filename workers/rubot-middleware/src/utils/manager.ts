/**
 * Manager + manager_tenants CRUD + ownership helpers.
 *
 * Read by `routes/auth.ts` (registration, login, confirm, reset) and
 * `routes/provision.ts` (PIN generate/get is gated on
 * `isManagerOwnerOf`).
 */

import type { AccountAuditRow, ManagerRow, ManagerTenantRow, TenantRow } from "../types";
import { hashPassword, verifyPassword } from "./password";
import { generateUuidV4 } from "./uuid";

interface BootstrapEnv {
  SUPERADMIN_EMAIL?: string;
}

export interface TenantSummary {
  tenant_id: string;
  name: string | null;
  created_at: number;
}

const generateManagerId = generateUuidV4;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getManagerById(
  db: D1Database,
  managerId: string,
): Promise<ManagerRow | null> {
  return db
    .prepare("SELECT * FROM managers WHERE manager_id = ?")
    .bind(managerId)
    .first<ManagerRow>();
}

export async function getManagerByEmail(
  db: D1Database,
  email: string,
): Promise<ManagerRow | null> {
  return db
    .prepare("SELECT * FROM managers WHERE email = ?")
    .bind(normalizeEmail(email))
    .first<ManagerRow>();
}

function isBootstrapEmail(env: BootstrapEnv, email: string): boolean {
  const target = (env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
  return !!target && target === normalizeEmail(email);
}

/**
 * Insert a manager row. Returns `{manager, confirmationToken, bootstrapped}`.
 *
 * Normal path: email_confirmed=0, approved=0, is_superadmin=0, returns a
 * confirmation token so the route can email it.
 *
 * Bootstrap path (email matches `env.SUPERADMIN_EMAIL`):
 * email_confirmed=1, approved=1, is_superadmin=1. confirmationToken is
 * still returned for API uniformity but the caller should SKIP sending
 * the email — that account is already active.
 */
export async function createManager(
  db: D1Database,
  env: BootstrapEnv,
  email: string,
  password: string,
): Promise<{ manager: ManagerRow; confirmationToken: string; bootstrapped: boolean }> {
  const managerId = generateManagerId();
  const passwordHash = await hashPassword(password);
  const normalized = normalizeEmail(email);
  const confirmationToken = generateToken();
  const bootstrapped = isBootstrapEmail(env, email);
  const now = Math.floor(Date.now() / 1000);

  if (bootstrapped) {
    await db
      .prepare(
        `INSERT INTO managers
           (manager_id, email, password_hash, email_confirmed, confirmation_token,
            approved, approved_by, approved_at, is_superadmin)
         VALUES (?, ?, ?, 1, NULL, 1, NULL, ?, 1)`,
      )
      .bind(managerId, normalized, passwordHash, now)
      .run();
    await db
      .prepare(
        "INSERT INTO account_audit (manager_id, actor_id, action, reason) VALUES (?, NULL, 'bootstrap', 'SUPERADMIN_EMAIL match on register')",
      )
      .bind(managerId)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO managers (manager_id, email, password_hash, email_confirmed, confirmation_token) VALUES (?, ?, ?, 0, ?)",
      )
      .bind(managerId, normalized, passwordHash, confirmationToken)
      .run();
  }

  const row = await getManagerById(db, managerId);
  if (!row) throw new Error("manager_create_failed");
  return { manager: row, confirmationToken, bootstrapped };
}

export async function confirmEmail(
  db: D1Database,
  token: string,
): Promise<ManagerRow | null> {
  const manager = await db
    .prepare("SELECT * FROM managers WHERE confirmation_token = ?")
    .bind(token)
    .first<ManagerRow>();
  if (!manager) return null;

  await db
    .prepare(
      "UPDATE managers SET email_confirmed = 1, confirmation_token = NULL WHERE manager_id = ?",
    )
    .bind(manager.manager_id)
    .run();

  return { ...manager, email_confirmed: 1, confirmation_token: null };
}

export async function createPasswordReset(
  db: D1Database,
  email: string,
): Promise<{ token: string; manager: ManagerRow } | null> {
  const manager = await getManagerByEmail(db, email);
  if (!manager) return null;

  const token = generateToken();
  const expires = Math.floor(Date.now() / 1000) + 3600;

  await db
    .prepare(
      "UPDATE managers SET reset_token = ?, reset_expires = ? WHERE manager_id = ?",
    )
    .bind(token, expires, manager.manager_id)
    .run();

  return { token, manager };
}

export async function consumePasswordReset(
  db: D1Database,
  token: string,
  newPasswordHash: string,
): Promise<ManagerRow | null> {
  const manager = await db
    .prepare("SELECT * FROM managers WHERE reset_token = ?")
    .bind(token)
    .first<ManagerRow>();

  if (!manager) return null;
  if (
    !manager.reset_expires ||
    manager.reset_expires < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  await db
    .prepare(
      "UPDATE managers SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE manager_id = ?",
    )
    .bind(newPasswordHash, manager.manager_id)
    .run();

  return {
    ...manager,
    password_hash: newPasswordHash,
    reset_token: null,
    reset_expires: null,
  };
}

export async function verifyManagerCredentials(
  db: D1Database,
  email: string,
  password: string,
): Promise<ManagerRow | null> {
  const manager = await getManagerByEmail(db, email);
  if (!manager) return null;
  const valid = await verifyPassword(password, manager.password_hash);
  return valid ? manager : null;
}

export async function linkManagerTenant(
  db: D1Database,
  managerId: string,
  tenantId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO manager_tenants (manager_id, tenant_id) VALUES (?, ?)
       ON CONFLICT(manager_id, tenant_id) DO NOTHING`,
    )
    .bind(managerId, tenantId)
    .run();
}

export async function unlinkManagerTenant(
  db: D1Database,
  managerId: string,
  tenantId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM manager_tenants WHERE manager_id = ? AND tenant_id = ?")
    .bind(managerId, tenantId)
    .run();
}

export async function isManagerOwnerOf(
  db: D1Database,
  managerId: string,
  tenantId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM manager_tenants WHERE manager_id = ? AND tenant_id = ? LIMIT 1",
    )
    .bind(managerId, tenantId)
    .first<{ ok: number }>();
  return row?.ok === 1;
}

// ── admin helpers (super-admin only callers) ───────────────────

export type ManagerListFilter = "pending" | "approved" | "all";

export interface ManagerListEntry {
  manager_id: string;
  email: string;
  email_confirmed: number;
  approved: number;
  is_superadmin: number;
  approved_at: number | null;
  created_at: number;
}

export async function listManagers(
  db: D1Database,
  filter: ManagerListFilter,
): Promise<ManagerListEntry[]> {
  let sql = `SELECT manager_id, email, email_confirmed, approved, is_superadmin, approved_at, created_at
             FROM managers`;
  if (filter === "pending") sql += " WHERE approved = 0";
  else if (filter === "approved") sql += " WHERE approved = 1";
  sql += " ORDER BY created_at DESC";

  const { results } = await db.prepare(sql).all<ManagerListEntry>();
  return results;
}

async function writeAudit(
  db: D1Database,
  managerId: string,
  actorId: string | null,
  action: string,
  reason: string | null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO account_audit (manager_id, actor_id, action, reason) VALUES (?, ?, ?, ?)",
    )
    .bind(managerId, actorId, action, reason)
    .run();
}

export async function approveManager(
  db: D1Database,
  managerId: string,
  actorId: string,
): Promise<ManagerRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      "UPDATE managers SET approved = 1, approved_by = ?, approved_at = ? WHERE manager_id = ?",
    )
    .bind(actorId, now, managerId)
    .run();
  if (!res.success) return null;
  await writeAudit(db, managerId, actorId, "approve", null);
  return getManagerById(db, managerId);
}

export async function revokeManager(
  db: D1Database,
  managerId: string,
  actorId: string,
  reason: string | null,
): Promise<ManagerRow | null> {
  await db
    .prepare(
      "UPDATE managers SET approved = 0, approved_by = NULL, approved_at = NULL WHERE manager_id = ?",
    )
    .bind(managerId)
    .run();
  await writeAudit(db, managerId, actorId, "revoke", reason);
  return getManagerById(db, managerId);
}

export async function setSuperadmin(
  db: D1Database,
  managerId: string,
  grant: boolean,
  actorId: string,
): Promise<ManagerRow | null> {
  await db
    .prepare("UPDATE managers SET is_superadmin = ? WHERE manager_id = ?")
    .bind(grant ? 1 : 0, managerId)
    .run();
  await writeAudit(db, managerId, actorId, grant ? "promote" : "demote", null);
  return getManagerById(db, managerId);
}

export async function listAccountAudit(
  db: D1Database,
  managerId: string,
): Promise<AccountAuditRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM account_audit WHERE manager_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(managerId)
    .all<AccountAuditRow>();
  return results;
}

export async function listManagerTenants(
  db: D1Database,
  managerId: string,
): Promise<TenantSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT t.tenant_id, t.name, mt.created_at
       FROM manager_tenants mt
       LEFT JOIN tenants t ON t.tenant_id = mt.tenant_id
       WHERE mt.manager_id = ?
       ORDER BY mt.created_at DESC`,
    )
    .bind(managerId)
    .all<Pick<TenantRow, "tenant_id" | "name"> & Pick<ManagerTenantRow, "created_at">>();
  return results.map((r) => ({
    tenant_id: r.tenant_id,
    name: r.name,
    created_at: r.created_at,
  }));
}
