/**
 * /api/proxy/* — generic cookie-forwarding pass-through to rubot-middleware
 * over the Service Binding. Browser code only ever talks to this proxy,
 * never to middleware directly, so the rubot_session cookie stays in a
 * single first-party origin.
 *
 * Path forwarding: /api/proxy/<rest> → middleware /api/<rest>
 *   e.g.  POST /api/proxy/auth/login  → middleware POST /api/auth/login
 */

import type { APIContext, APIRoute } from "astro";
import { callMiddleware, type RubotEnv } from "../../../lib/middleware";

function buildPath(ctx: APIContext): string {
  const raw = ctx.params.path;
  const segments = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  // Preserve query string from the inbound URL — middleware uses ?token=
  // on /api/auth/confirm-email.
  const url = new URL(ctx.request.url);
  const qs = url.search;
  return `/api/${segments}${qs}`;
}

async function forward(ctx: APIContext): Promise<Response> {
  const env = ctx.locals.runtime.env as unknown as RubotEnv;
  const req = ctx.request;
  const path = buildPath(ctx);
  const cookie = req.headers.get("Cookie") ?? "";

  const method = req.method.toUpperCase();
  const bodyText = method === "GET" || method === "HEAD" ? null : await req.text();

  const upstream = await callMiddleware(env, {
    method,
    path,
    cookie,
    contentType: req.headers.get("Content-Type") ?? "application/json",
    body: bodyText,
  });

  // Pass through middleware's Set-Cookie verbatim (login + confirm-email
  // both rely on it) and its status. The body we re-emit as-is.
  const headers = new Headers(upstream.headers);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET: APIRoute = forward;
export const POST: APIRoute = forward;
export const PUT: APIRoute = forward;
export const DELETE: APIRoute = forward;
export const PATCH: APIRoute = forward;
