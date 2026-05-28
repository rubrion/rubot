/**
 * Resolve the current manager by asking rubot-middleware whether the
 * inbound Cookie header carries a valid rubot_session.
 *
 * The rubot-client deliberately does NOT hold SESSION_SIGNING_SECRET —
 * cookie verification is delegated to middleware /api/auth/me, which is
 * already the authoritative source of truth.
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
  if ((env.RUBOT_DATA_AUTH ?? "bearer") === "open") return null;

  const res = await callMiddleware(env, {
    method: "GET",
    path: "/api/auth/me",
    cookie,
  });

  const body = await jsonOrNull<ApiEnvelope<CurrentManager>>(res);
  if (!body || body.success !== true) return null;
  return body.data;
}

export function isBearerMode(env: RubotEnv): boolean {
  return (env.RUBOT_DATA_AUTH ?? "bearer") !== "open";
}
