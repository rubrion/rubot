-- rubot-middleware D1 schema (binding: rubot_data → env.DB).
--
-- Run locally:
--   wrangler d1 execute rubot_data --file=schema.sql
--   wrangler d1 execute rubot_data --remote --file=schema.sql

-- ── tenants ─────────────────────────────────────────────────────
-- One row per tenant. `secret_hash` is the SHA-256 of the long-lived
-- per-tenant bearer secret (used by external callers; minted bearers
-- are validated cryptographically, not through this row).
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id    TEXT    PRIMARY KEY,
  email        TEXT    UNIQUE,
  secret_hash  TEXT    NOT NULL,
  name         TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── integration_tokens ──────────────────────────────────────────
-- One row per (tenant, provider). Skeleton uses `example-provider` only —
-- real deployments add OAuth/API-key fields per provider as needed.
CREATE TABLE IF NOT EXISTS integration_tokens (
  tenant_id      TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     INTEGER NOT NULL DEFAULT 0,
  auto_renew     INTEGER NOT NULL DEFAULT 0, -- 0|1
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, provider)
);

-- ── session_bearers ─────────────────────────────────────────────
-- Used by rubot-gateway: maps chat-source session_id → short-lived
-- minted bearer scoped to a tenant. Written by /api/internal/bind-session.
CREATE TABLE IF NOT EXISTS session_bearers (
  session_id  TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL,
  bearer      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  sender_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_bearers_expires_at
  ON session_bearers(expires_at);

-- ── identity_bindings ───────────────────────────────────────────
-- Generic "this chat-source sender belongs to this tenant" mapping
-- (replaces the old phone_users table — no transport assumed).
CREATE TABLE IF NOT EXISTS identity_bindings (
  sender_id   TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_identity_bindings_tenant
  ON identity_bindings(tenant_id);

-- ── manager_tenants ─────────────────────────────────────────────
-- A "manager" is a human dashboard user; each manager owns N tenants.
-- Manager rows live in the `managers` table below.
CREATE TABLE IF NOT EXISTS manager_tenants (
  manager_id  TEXT    NOT NULL,
  tenant_id   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (manager_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_tenants_tenant
  ON manager_tenants(tenant_id);

-- ── managers ────────────────────────────────────────────────────
-- Dashboard users. One row per human operator. Owns N tenants via
-- manager_tenants. The auth surface (/api/auth/*) is always mounted —
-- both bearer- and open-mode dashboards need login. Tenant-scoped
-- routes (/api/tenant/*, /api/provision/*) remain bearer-only.
--
-- Account states:
--   email_confirmed=0 → pending email confirmation
--   email_confirmed=1, approved=0 → pending super-admin approval
--   email_confirmed=1, approved=1 → fully active
-- The bootstrap super-admin (env: SUPERADMIN_EMAIL) is inserted with
-- email_confirmed=1, approved=1, is_superadmin=1 directly on register.
CREATE TABLE IF NOT EXISTS managers (
  manager_id          TEXT    PRIMARY KEY,
  email               TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  email_confirmed     INTEGER NOT NULL DEFAULT 0,
  confirmation_token  TEXT,
  reset_token         TEXT,
  reset_expires       INTEGER,
  approved            INTEGER NOT NULL DEFAULT 0,
  approved_by         TEXT,
  approved_at         INTEGER,
  is_superadmin       INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_managers_confirmation_token
  ON managers(confirmation_token) WHERE confirmation_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_managers_reset_token
  ON managers(reset_token) WHERE reset_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_managers_pending
  ON managers(approved) WHERE approved = 0;
CREATE INDEX IF NOT EXISTS idx_managers_superadmin
  ON managers(is_superadmin) WHERE is_superadmin = 1;

-- ── account_audit ───────────────────────────────────────────────
-- Every approve/revoke/promote/demote action leaves a row. actor_id
-- NULL = system action (bootstrap via SUPERADMIN_EMAIL env). action
-- is a free-text label by design — extend without DDL.
CREATE TABLE IF NOT EXISTS account_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id   TEXT    NOT NULL,
  actor_id     TEXT,
  action       TEXT    NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_account_audit_manager
  ON account_audit(manager_id);

-- ── tenant_agents ───────────────────────────────────────────────
-- Per-tenant enable/disable for registered specialist agents.
-- Absence of a row = default enabled (the orchestrator's preflight
-- filter treats an empty set as "no filter, all enabled").
CREATE TABLE IF NOT EXISTS tenant_agents (
  tenant_id   TEXT    NOT NULL,
  agent_id    TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_agents_tenant
  ON tenant_agents(tenant_id);
