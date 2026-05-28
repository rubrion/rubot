/**
 * Typed wrapper around the rubot-middleware Service Binding.
 *
 * Mirrors rubot-client/lib/middleware.ts. Callers pass through the
 * inbound request's Cookie header so the manager's rubot_session is
 * forwarded — middleware resolves manager_id on every /api/auth +
 * /api/admin call.
 */

export interface MiddlewareBinding {
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface RubotEnv {
  MIDDLEWARE: MiddlewareBinding;
  RUBOT_DATA_AUTH?: string;
}

const MIDDLEWARE_ORIGIN = "https://rubot-middleware.internal";

export interface MiddlewareCallOptions {
  method?: string;
  path: string;
  cookie?: string;
  contentType?: string;
  body?: BodyInit | null;
}

export async function callMiddleware(
  env: RubotEnv,
  opts: MiddlewareCallOptions,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.contentType) headers["Content-Type"] = opts.contentType;

  return env.MIDDLEWARE.fetch(`${MIDDLEWARE_ORIGIN}${opts.path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ?? undefined,
  });
}

export async function jsonOrNull<T = unknown>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}
export interface FailureEnvelope {
  success: false;
  error: string;
}
export type ApiEnvelope<T> = SuccessEnvelope<T> | FailureEnvelope;
