/**
 * /api/provision/* — PIN lifecycle that binds a chat-source sender_id
 * (Telegram chat id, WhatsApp E.164, Slack user id, …) to a tenant_id.
 *
 * Mounted only when `RUBOT_DATA_AUTH=bearer`. Open mode has no notion
 * of tenant ownership or per-tenant access — every data route is
 * public, so administering PINs would be meaningless.
 *
 * Endpoints:
 *   POST /generate          — manager session; force-rotate PIN for owned tenant.
 *   GET  /pin/:tenantId     — manager session; lazy-init + return current PIN.
 *   POST /consume           — public; burn PIN, insert identity_bindings row.
 *
 * KV layout (binding: PROVISIONING):
 *   `<pin>`             → `<tenant_id>`  (reverse lookup for consume)
 *   `tenant:<tenant_id>` → JSON{ pin, expiresAt }  (forward lookup for manager UI)
 * Both keys carry the same expirationTtl; a freshly-generated PIN
 * burns the previous one immediately.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../types";
import { requireApprovedManager } from "../utils/session";
import { isManagerOwnerOf } from "../utils/manager";
import { SENDER_ID_RX, TENANT_ID_RX } from "../utils/validate";

const provisionApp = new Hono<AppContext>();

export const PIN_TTL_SEC = 60 * 5; // 5 minutes
const PIN_MAX_RETRIES = 5;

function generatePin(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0] % 1_000_000;
  return n.toString().padStart(6, "0");
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

interface TenantPinRecord {
  pin: string;
  expiresAt: number;
}

/**
 * Rotate the PIN for a tenant unconditionally:
 *   1. Delete old PIN's reverse-lookup key.
 *   2. Generate a fresh collision-safe PIN.
 *   3. Write both `<pin>` and `tenant:<tenantId>` keys with PIN_TTL_SEC.
 *
 * expiresAt is stored in the tenant key so subsequent reads return the
 * real expiry, not a freshly-computed "now + TTL" that would reset the
 * client countdown on every page refresh.
 */
async function upsertTenantPin(
  kv: KVNamespace,
  tenantId: string,
): Promise<TenantPinRecord> {
  const tenantKey = `tenant:${tenantId}`;
  const old = await kv.get<TenantPinRecord>(tenantKey, "json");
  if (old?.pin) {
    await kv.delete(old.pin);
  }

  let pin = "";
  for (let attempt = 0; attempt < PIN_MAX_RETRIES; attempt++) {
    const candidate = generatePin();
    const existing = await kv.get(candidate);
    if (!existing) {
      pin = candidate;
      break;
    }
  }
  if (!pin) throw new Error("pin_allocation_failed");

  const expiresAt = Math.floor(Date.now() / 1000) + PIN_TTL_SEC;
  await kv.put(pin, tenantId, { expirationTtl: PIN_TTL_SEC });
  await kv.put(tenantKey, JSON.stringify({ pin, expiresAt }), {
    expirationTtl: PIN_TTL_SEC,
  });

  return { pin, expiresAt };
}

/**
 * Return the existing PIN for a tenant if still valid (preserving its
 * original expiresAt), or generate a new one if the key is missing or
 * the reverse lookup disagrees.
 */
async function getOrCreateTenantPin(
  kv: KVNamespace,
  tenantId: string,
): Promise<TenantPinRecord> {
  const tenantKey = `tenant:${tenantId}`;
  const record = await kv.get<TenantPinRecord>(tenantKey, "json");
  if (record?.pin && record?.expiresAt) {
    const ownerCheck = await kv.get(record.pin);
    if (ownerCheck === tenantId) {
      return record;
    }
  }
  return upsertTenantPin(kv, tenantId);
}

interface GenerateBody {
  tenant_id?: string;
}

provisionApp.post("/generate", async (c) => {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;

  const body = await parseJson<GenerateBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const tenantId = (body.tenant_id || "").trim();
  if (!tenantId) return fail(c, "missing_tenant_id", 400);
  if (!TENANT_ID_RX.test(tenantId)) return fail(c, "invalid_tenant_id", 400);

  if (!(await isManagerOwnerOf(c.env.DB, guard.manager_id, tenantId))) {
    return fail(c, "forbidden", 403);
  }

  try {
    const { pin, expiresAt } = await upsertTenantPin(c.env.PROVISIONING, tenantId);
    return ok(c, { pin, tenant_id: tenantId, expires_at: expiresAt });
  } catch {
    return fail(c, "pin_allocation_failed", 503);
  }
});

provisionApp.get("/pin/:tenantId", async (c) => {
  const guard = await requireApprovedManager(c);
  if (guard instanceof Response) return guard;

  const tenantId = c.req.param("tenantId");
  if (!TENANT_ID_RX.test(tenantId)) return fail(c, "invalid_tenant_id", 400);

  if (!(await isManagerOwnerOf(c.env.DB, guard.manager_id, tenantId))) {
    return fail(c, "forbidden", 403);
  }

  try {
    const { pin, expiresAt } = await getOrCreateTenantPin(
      c.env.PROVISIONING,
      tenantId,
    );
    return ok(c, { pin, tenant_id: tenantId, expires_at: expiresAt });
  } catch {
    return fail(c, "pin_allocation_failed", 503);
  }
});

interface ConsumeBody {
  pin?: string;
  sender_id?: string;
}

/**
 * POST /api/provision/consume — public.
 *
 * Body: { pin, sender_id }. On success, writes
 * identity_bindings(sender_id → tenant_id) and burns the PIN.
 * Subsequent /api/internal/bind-session calls can resolve the sender's
 * tenant_id via the binding.
 */
provisionApp.post("/consume", async (c) => {
  const body = await parseJson<ConsumeBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const pin = (body.pin || "").trim();
  const senderId = (body.sender_id || "").trim();

  if (!/^\d{6}$/.test(pin)) return fail(c, "invalid_pin_format", 400);
  if (!SENDER_ID_RX.test(senderId)) return fail(c, "invalid_sender_id", 400);

  const kv = c.env.PROVISIONING;
  const tenantId = await kv.get(pin);
  if (!tenantId) return fail(c, "invalid_pin", 400);

  await c.env.DB
    .prepare(
      `INSERT INTO identity_bindings (sender_id, tenant_id) VALUES (?, ?)
       ON CONFLICT(sender_id) DO UPDATE SET tenant_id = excluded.tenant_id`,
    )
    .bind(senderId, tenantId)
    .run();

  await kv.delete(pin);
  await kv.delete(`tenant:${tenantId}`);

  return ok(c, { linked: true, tenant_id: tenantId, sender_id: senderId });
});

export default provisionApp;
