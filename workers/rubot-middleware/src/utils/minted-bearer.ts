/**
 * Minted bearer — short-lived, per-tenant authentication token.
 *
 * Minted by /api/internal/bind-session (called by rubot-gateway via
 * Service Binding when a chat session starts) and consumed by data
 * routes here. The HMAC signing key (BEARER_SIGNING_SECRET) is shared
 * with rubot-gateway so the gateway can mint/refresh without round-trip
 * to this worker, and verify without keeping any KV/D1 state.
 *
 * Token shape:  mbr.v1.<tenantIdB64url>.<expSec>.<sigB64url>
 *
 * This file MUST stay byte-identical (in format and signing) with the
 * gateway's bearer helper — they exchange tokens directly.
 */

const TOKEN_PREFIX = "mbr.";
const VERSION = "v1";
const VERSION_SALT = "minted-bearer.v1";
const DEFAULT_TTL_SEC = 60 * 5;       // 5 min
export const MIN_TTL_SEC = 60;        // 1 min
export const MAX_TTL_SEC = 60 * 15;   // 15 min

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
  const keyBytes = new TextEncoder().encode(`${VERSION_SALT}|${rawSecret}`);
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
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(sig));
}

async function verifySig(payload: string, sigB64: string, rawSecret: string): Promise<boolean> {
  const key = await importKey(rawSecret);
  const sig = fromBase64Url(sigB64);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

export interface MintedBearer {
  tenantId: string;
  exp: number;
}

export async function mintBearer(
  tenantId: string,
  rawSecret: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<{ token: string; exp: number }> {
  const clamped = Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, Math.floor(ttlSec)));
  const exp = Math.floor(Date.now() / 1000) + clamped;
  const tenantIdB64 = toBase64Url(new TextEncoder().encode(tenantId));
  const payload = `${VERSION}.${tenantIdB64}.${exp}`;
  const sig = await sign(payload, rawSecret);
  return { token: `${TOKEN_PREFIX}${payload}.${sig}`, exp };
}

export function isMintedBearer(bearer: string): boolean {
  return bearer.startsWith(TOKEN_PREFIX);
}

export async function verifyMintedBearer(
  bearer: string,
  rawSecret: string,
): Promise<MintedBearer | null> {
  if (!isMintedBearer(bearer)) return null;
  const parts = bearer.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 4) return null;

  const [version, tenantIdB64, expStr, sigB64] = parts;
  if (version !== VERSION) return null;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;

  const payload = `${version}.${tenantIdB64}.${expStr}`;
  const valid = await verifySig(payload, sigB64, rawSecret);
  if (!valid) return null;

  try {
    const tenantId = new TextDecoder().decode(fromBase64Url(tenantIdB64));
    return { tenantId, exp };
  } catch {
    return null;
  }
}
