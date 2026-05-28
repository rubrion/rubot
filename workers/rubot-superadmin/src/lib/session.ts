/**
 * Session resolver — calls middleware /api/auth/me and returns the
 * current manager. `assertSuperadmin` adds the is_superadmin gate that
 * every page under /admin/* runs at the layout level.
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
