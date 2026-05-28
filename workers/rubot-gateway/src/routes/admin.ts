import { Hono } from "hono";
import type { AppContext, IdentityBindingRow } from "../types";

/**
 * Identity-bindings admin CRUD (PLACEHOLDER).
 *
 * Maps a stable chat-source sender_id → tenant_id. The middleware's
 * bind-session route reads from this table during the first turn of a
 * freshly-linked session.
 *
 * `sender_id` is treated as an opaque string — implement a sender allowlist
 * or normalization step downstream if your chat-source requires it.
 *
 * TODO: this assumes an `identity_bindings (sender_id, tenant_id, created_at)`
 *       table in D1. Wire up the migration in the shared migrations dir
 *       before relying on these endpoints.
 */

const admin = new Hono<AppContext>();

admin.use("*", async (c, next) => {
  const apiKey = c.env.ADMIN_API_KEY;
  if (!apiKey) {
    return c.json({ error: "server misconfigured: ADMIN_API_KEY not set" }, 500);
  }

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${apiKey}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
});

admin.get("/identity-bindings", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      "SELECT sender_id, tenant_id, created_at FROM identity_bindings ORDER BY created_at DESC",
    )
    .all<IdentityBindingRow>();

  return c.json({ identity_bindings: results });
});

admin.post("/identity-bindings", async (c) => {
  const { sender_id, tenant_id } = await c.req.json<{
    sender_id: string;
    tenant_id: string;
  }>();

  if (!sender_id || !tenant_id) {
    return c.json({ error: "both 'sender_id' and 'tenant_id' are required" }, 400);
  }

  const db = c.env.DB;
  await db
    .prepare(
      "INSERT INTO identity_bindings (sender_id, tenant_id) VALUES (?, ?) ON CONFLICT(sender_id) DO UPDATE SET tenant_id = excluded.tenant_id",
    )
    .bind(sender_id, tenant_id)
    .run();

  return c.json({ ok: true, sender_id, tenant_id }, 201);
});

admin.delete("/identity-bindings/:sender_id", async (c) => {
  const senderId = c.req.param("sender_id");
  const db = c.env.DB;

  const result = await db
    .prepare("DELETE FROM identity_bindings WHERE sender_id = ?")
    .bind(senderId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({ ok: true, deleted: senderId });
});

export default admin;
