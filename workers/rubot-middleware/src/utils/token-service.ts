/**
 * Placeholder provider-token interface.
 *
 * Real implementations replace these stubs with provider-specific OAuth
 * refresh flows (and per-provider expiry semantics). For the skeleton,
 * `fetchTokensForTenant` is enough to power the /connections preflight.
 */

export interface TokenRow {
  tenant_id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number;
  auto_renew: number; // 0 | 1
  updated_at: number;
}

export async function fetchTokensForTenant(
  db: D1Database,
  tenantId: string,
): Promise<TokenRow[]> {
  const { results } = await db
    .prepare(
      `SELECT tenant_id, provider, access_token, refresh_token,
              expires_at, auto_renew, updated_at
         FROM integration_tokens
        WHERE tenant_id = ?`,
    )
    .bind(tenantId)
    .all<TokenRow>();
  return results ?? [];
}

/**
 * TODO: per-provider OAuth refresh.
 *
 * Each concrete provider implements its own refresh — typically:
 *   1. POST to <token_endpoint> with grant_type=refresh_token
 *   2. Parse access_token + (optionally rotated) refresh_token + expires_in
 *   3. UPSERT into integration_tokens with new expires_at
 *
 * Keep the signature uniform so callers can refresh without knowing
 * which provider is in play.
 */
export async function refreshProviderToken(
  _db: D1Database,
  _tenantId: string,
  _provider: string,
): Promise<TokenRow | null> {
  // Stub: real providers implement their own refresh and write back to
  // integration_tokens. See `src/providers/example-provider/index.ts`
  // for the pattern.
  return null;
}
