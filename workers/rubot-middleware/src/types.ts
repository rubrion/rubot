/**
 * Centralised Bindings + row types for rubot-middleware.
 *
 * Worker env (`c.env`) is typed by `Bindings`; row helpers in `utils/`
 * return the row interfaces below. Keep this file the single source of
 * truth — `routes/internal.ts` re-exports `Bindings` for back-compat with
 * existing imports.
 */

export interface Bindings {
  DB: D1Database;
  PROVISIONING: KVNamespace;
  ENVIRONMENT: string;
  RUBOT_DEPLOYMENT_HASH: string;

  // Set via `wrangler secret put MIDDLEWARE_API_KEY`. Authenticates
  // inbound calls from rubot-gateway over a Service Binding.
  MIDDLEWARE_API_KEY?: string;

  // Set via `wrangler secret put BEARER_SIGNING_SECRET`. HMAC key used
  // to sign/verify short-lived minted data bearers (`mbr.v1...`). Shared
  // with rubot-gateway. Separate from SESSION_SIGNING_SECRET on purpose.
  BEARER_SIGNING_SECRET: string;

  // Data-route auth mode: "bearer" (default, HMAC bearers required) or
  // "open" (no auth, /api/auth/* + /api/provision/* unmounted).
  RUBOT_DATA_AUTH?: string;

  // Set via `wrangler secret put SESSION_SIGNING_SECRET`. HMAC key for
  // the `rubot_session` manager cookie. NOT the same as
  // BEARER_SIGNING_SECRET — manager-session compromise must not pivot to
  // data-bearer forgery.
  SESSION_SIGNING_SECRET: string;

  // Set via `wrangler secret put RESEND_API_KEY`. Optional — when empty,
  // confirmation/reset URLs are logged to the worker console instead of
  // sent, which keeps local dev runnable without Resend.
  RESEND_API_KEY?: string;

  // Base URL of the manager dashboard. Used to build confirmation/reset
  // links emailed to the user.
  FRONTEND_URL?: string;

  // From address on outbound mail. Defaults to "Rubot
  // <noreply@example.com>" — override per deploy.
  MAIL_FROM?: string;

  // Display name used inside the email body. Defaults to "Rubot".
  MAIL_BRAND_NAME?: string;

  // JSON array of registered agent ids the dashboard can toggle.
  // Example: `["template","conversational"]`. Single source of truth
  // mirrored from rubot-orchestrator's AGENT_REGISTRY_JSON keys.
  // When empty, the /api/tenant/:tenantId/agents endpoint returns [].
  KNOWN_AGENTS_JSON?: string;

  // Bootstrap super-admin email. The first /api/auth/register call
  // whose email matches (case-insensitive) is auto-confirmed +
  // auto-approved + auto-elevated, and no confirmation mail is sent.
  // Unset/empty → first super-admin must be granted via D1 by hand.
  SUPERADMIN_EMAIL?: string;
}

export type AppContext = { Bindings: Bindings };

export interface ManagerRow {
  manager_id: string;
  email: string;
  password_hash: string;
  email_confirmed: number; // 0 | 1
  confirmation_token: string | null;
  reset_token: string | null;
  reset_expires: number | null;
  approved: number; // 0 | 1
  approved_by: string | null;
  approved_at: number | null;
  is_superadmin: number; // 0 | 1
  created_at: number;
}

export interface AccountAuditRow {
  id: number;
  manager_id: string;
  actor_id: string | null;
  action: string; // approve | revoke | promote | demote | bootstrap
  reason: string | null;
  created_at: number;
}

export interface ManagerTenantRow {
  manager_id: string;
  tenant_id: string;
  created_at: number;
}

export interface TenantRow {
  tenant_id: string;
  email: string | null;
  secret_hash: string;
  name: string | null;
  created_at: number;
}

export interface IdentityBindingRow {
  sender_id: string;
  tenant_id: string;
  created_at: number;
}

export interface IntegrationTokenRow {
  tenant_id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number;
  auto_renew: number;
  updated_at: number;
}

export interface TenantAgentRow {
  tenant_id: string;
  agent_id: string;
  enabled: number; // 0 | 1
  updated_at: number;
}
