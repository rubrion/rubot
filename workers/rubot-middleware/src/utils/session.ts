/**
 * HMAC-signed manager session cookie.
 *
 * Cookie shape: `rubot_session=v2.<managerIdB64>.<expSec>.<sigB64>`
 *
 * The signing key (`SESSION_SIGNING_SECRET`) is deliberately distinct
 * from `BEARER_SIGNING_SECRET` so compromise of one cannot forge the
 * other — manager-dashboard sessions and tenant-scoped data bearers are
 * different trust domains.
 */

import type { Context } from "hono";
import type { AppContext, ManagerRow } from "../types";
import { getManagerById } from "./manager";

const COOKIE_NAME = "rubot_session";
const SESSION_TTL_SEC = 60 * 60 * 24; // 24h
const SESSION_VERSION = "v2";

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(rawSecret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(
    `session.${SESSION_VERSION}|${rawSecret}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", keyBytes);
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, rawSecret: string): Promise<string> {
  const key = await importKey(rawSecret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toBase64Url(new Uint8Array(sig));
}

async function verifySig(
  payload: string,
  sigB64: string,
  rawSecret: string,
): Promise<boolean> {
  const key = await importKey(rawSecret);
  const sig = fromBase64Url(sigB64);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(payload),
  );
}

export async function buildSessionCookie(
  managerId: string,
  rawSecret: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const managerIdB64 = toBase64Url(new TextEncoder().encode(managerId));
  const payload = `${SESSION_VERSION}.${managerIdB64}.${exp}`;
  const sig = await sign(payload, rawSecret);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

export function readCookie<E extends AppContext>(
  c: Context<E>,
  name: string,
): string | null {
  const raw = c.req.header("Cookie") || "";
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1) || null;
  }
  return null;
}

/**
 * Back-compat shim: the stub auth.ts called `readSessionCookie(c)` to
 * pull the raw cookie value. New code should prefer
 * `readSessionManagerId(c, rawSecret)` which also verifies the HMAC.
 */
export function readSessionCookie<E extends AppContext>(
  c: Context<E>,
): string | null {
  return readCookie(c, COOKIE_NAME);
}

/**
 * Resolve the session cookie to a full ManagerRow and gate on
 * `approved === 1`. Returns the row on success, or a JSON Response
 * with the appropriate failure status that the caller should return
 * immediately.
 *
 *   401 unauthorized      — missing/invalid cookie
 *   401 unauthorized      — cookie resolves but row is gone (deleted account)
 *   403 not_approved      — approved=0 (pending or revoked)
 *
 * /api/auth/* + /api/admin/* + /api/provision/consume DON'T use this —
 * they have their own gating. /api/tenant/* and the manager-session
 * branches of /api/provision/* do.
 */
export async function requireApprovedManager<E extends AppContext>(
  c: Context<E>,
): Promise<ManagerRow | Response> {
  const managerId = await readSessionManagerId(c, c.env.SESSION_SIGNING_SECRET);
  if (!managerId) {
    return c.json({ success: false, error: "unauthorized" }, 401);
  }
  const manager = await getManagerById(c.env.DB, managerId);
  if (!manager) {
    return c.json({ success: false, error: "unauthorized" }, 401);
  }
  if (manager.approved !== 1) {
    return c.json({ success: false, error: "not_approved" }, 403);
  }
  return manager;
}

export async function readSessionManagerId<E extends AppContext>(
  c: Context<E>,
  rawSecret: string,
): Promise<string | null> {
  const cookie = readCookie(c, COOKIE_NAME);
  if (!cookie) return null;

  const parts = cookie.split(".");
  if (parts.length !== 4) return null;
  const [version, managerIdB64, expStr, sigB64] = parts;
  if (version !== SESSION_VERSION) return null;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;

  const payload = `${version}.${managerIdB64}.${expStr}`;
  const valid = await verifySig(payload, sigB64, rawSecret);
  if (!valid) return null;

  try {
    return new TextDecoder().decode(fromBase64Url(managerIdB64));
  } catch {
    return null;
  }
}
