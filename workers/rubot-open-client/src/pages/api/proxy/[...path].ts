/**
 * Generic cookie-forwarding proxy to rubot-middleware over the Service
 * Binding. Mirror of rubot-client's /api/proxy/[...path].ts. The
 * browser only ever talks to this proxy, keeping rubot_session inside
 * a single first-party origin.
 */

import type { APIContext, APIRoute } from "astro";
import { callMiddleware, type RubotEnv } from "../../../lib/middleware";

function buildPath(ctx: APIContext): string {
  const raw = ctx.params.path;
  const segments = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
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

  const headers = new Headers(upstream.headers);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET: APIRoute = forward;
export const POST: APIRoute = forward;
export const PUT: APIRoute = forward;
export const DELETE: APIRoute = forward;
export const PATCH: APIRoute = forward;
