/**
 * /api/auth/* — manager dashboard identity endpoints.
 *
 * Mounted only when `RUBOT_DATA_AUTH=bearer`. In open mode the router
 * in `src/index.ts` short-circuits all `/api/auth/*` requests to 404.
 *
 * Flow:
 *   register  → managers row with email_confirmed=0 + confirmation_token,
 *               confirmation email queued (dev-mode logs the URL).
 *   confirm   → flips email_confirmed=1, returns redirect + session cookie.
 *   login     → checks credentials, requires email_confirmed=1, returns
 *               session cookie.
 *   me        → resolves manager_id from cookie HMAC.
 *   logout    → clears cookie.
 *   forgot/reset → 1h token, no enumeration on /forgot.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../types";
import {
  buildSessionCookie,
  clearSessionCookie,
  readSessionManagerId,
} from "../utils/session";
import {
  confirmEmail,
  consumePasswordReset,
  createManager,
  createPasswordReset,
  getManagerByEmail,
  getManagerById,
  verifyManagerCredentials,
} from "../utils/manager";
import { sendConfirmationEmail, sendPasswordResetEmail } from "../utils/email";
import { hashPassword } from "../utils/password";

const authApp = new Hono<AppContext>();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

interface RegisterBody {
  email?: string;
  password?: string;
}
interface LoginBody {
  email?: string;
  password?: string;
}
interface ForgotPasswordBody {
  email?: string;
}
interface ResetPasswordBody {
  token?: string;
  password?: string;
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

authApp.post("/register", async (c) => {
  const body = await parseJson<RegisterBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const email = (body.email || "").trim();
  const password = body.password || "";

  if (!EMAIL_RX.test(email)) return fail(c, "invalid_email", 400);
  if (password.length < MIN_PASSWORD_LEN) return fail(c, "password_too_short", 400);

  const existing = await getManagerByEmail(c.env.DB, email);
  if (existing) return fail(c, "email_already_registered", 409);

  const { manager, confirmationToken, bootstrapped } = await createManager(
    c.env.DB,
    c.env,
    email,
    password,
  );

  // Bootstrap super-admins land active; skip the confirmation email.
  if (bootstrapped) {
    return ok(c, {
      pending_confirmation: false,
      bootstrapped: true,
      manager_id: manager.manager_id,
    });
  }

  const frontend = c.env.FRONTEND_URL || "";
  const confirmUrl = `${frontend}/api/auth/confirm-email?token=${confirmationToken}`;
  await sendConfirmationEmail(c.env, manager.email, confirmUrl);

  return ok(c, { pending_confirmation: true });
});

authApp.post("/login", async (c) => {
  const body = await parseJson<LoginBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const email = (body.email || "").trim();
  const password = body.password || "";

  if (!email || !password) return fail(c, "invalid_credentials", 401);

  const manager = await verifyManagerCredentials(c.env.DB, email, password);
  if (!manager) return fail(c, "invalid_credentials", 401);
  if (manager.email_confirmed === 0) return fail(c, "email_not_confirmed", 403);

  const cookie = await buildSessionCookie(
    manager.manager_id,
    c.env.SESSION_SIGNING_SECRET,
  );
  const res = ok(c, {
    manager_id: manager.manager_id,
    email: manager.email,
    approved: manager.approved === 1,
    is_superadmin: manager.is_superadmin === 1,
  });
  res.headers.append("Set-Cookie", cookie);
  return res;
});

authApp.post("/logout", (c) => {
  const res = ok(c, { logged_out: true });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
});

authApp.get("/me", async (c) => {
  const managerId = await readSessionManagerId(c, c.env.SESSION_SIGNING_SECRET);
  if (!managerId) return fail(c, "unauthorized", 401);

  const manager = await getManagerById(c.env.DB, managerId);
  if (!manager) {
    const res = fail(c, "unauthorized", 401);
    res.headers.append("Set-Cookie", clearSessionCookie());
    return res;
  }

  return ok(c, {
    manager_id: manager.manager_id,
    email: manager.email,
    approved: manager.approved === 1,
    is_superadmin: manager.is_superadmin === 1,
  });
});

authApp.get("/confirm-email", async (c) => {
  const token = c.req.query("token") || "";
  if (!token) return fail(c, "missing_token", 400);

  const manager = await confirmEmail(c.env.DB, token);
  if (!manager) return fail(c, "invalid_or_expired_token", 400);

  const cookie = await buildSessionCookie(
    manager.manager_id,
    c.env.SESSION_SIGNING_SECRET,
  );
  const frontendUrl = c.env.FRONTEND_URL || "";
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${frontendUrl}/dashboard`,
      "Set-Cookie": cookie,
    },
  });
});

authApp.post("/forgot-password", async (c) => {
  const body = await parseJson<ForgotPasswordBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const email = (body.email || "").trim();
  if (!EMAIL_RX.test(email)) return fail(c, "invalid_email", 400);

  const result = await createPasswordReset(c.env.DB, email);
  if (result) {
    const frontend = c.env.FRONTEND_URL || "";
    const resetUrl = `${frontend}/reset-password?token=${result.token}`;
    await sendPasswordResetEmail(c.env, result.manager.email, resetUrl);
  }

  // Always return success — no enumeration of which emails exist.
  return ok(c, { sent: true });
});

authApp.post("/reset-password", async (c) => {
  const body = await parseJson<ResetPasswordBody>(c);
  if (!body) return fail(c, "invalid_json", 400);

  const token = (body.token || "").trim();
  const password = body.password || "";

  if (!token) return fail(c, "missing_token", 400);
  if (password.length < MIN_PASSWORD_LEN) return fail(c, "password_too_short", 400);

  const newHash = await hashPassword(password);
  const manager = await consumePasswordReset(c.env.DB, token, newHash);
  if (!manager) return fail(c, "invalid_or_expired_token", 400);

  return ok(c, { reset: true });
});

export default authApp;
