/**
 * Resolve the current manager via middleware /api/auth/me.
 *
 * Unlike rubot-client (which refuses to render in open mode), this
 * client is FOR open mode. The session lookup runs regardless of the
 * RUBOT_DATA_AUTH env var.
 */

import { callMiddleware, jsonOrNull, type RubotEnv, type ApiEnvelope } from "./middleware";

export interface CurrentManager {
  manager_id: string;
  email: string;
  approved: boolean;
  is_superadmin: boolean;
}

export async function currentManager(
  env: RubotEnv,
  cookie: string | null,
): Promise<CurrentManager | null> {
  if (!cookie) return null;

  const res = await callMiddleware(env, {
    method: "GET",
    path: "/api/auth/me",
    cookie,
  });

  const body = await jsonOrNull<ApiEnvelope<CurrentManager>>(res);
  if (!body || body.success !== true) return null;
  return body.data;
}
