/**
 * Long-lived per-tenant bearer secret validation.
 *
 * Used by the data-route auth middleware as a fallback path when the
 * caller did not present a minted bearer. The plaintext is hashed with
 * SHA-256 and compared to `tenants.secret_hash`.
 */

export async function hashSecret(secret: string): Promise<string> {
  const encoded = new TextEncoder().encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyTenantSecret(
  db: D1Database,
  tenantId: string,
  plainSecret: string,
): Promise<boolean> {
  if (!plainSecret) return false;
  const row = await db
    .prepare("SELECT secret_hash FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ secret_hash: string }>();
  if (!row) return false;
  const hash = await hashSecret(plainSecret);
  return hash === row.secret_hash;
}
