/**
 * Typed wrapper around the rubot-middleware Service Binding.
 *
 * Callers MUST pass through the inbound request's Cookie header so the
 * manager's rubot_session is forwarded — that's how the middleware
 * resolves the manager_id on every /api/auth + /api/tenant call.
 *
 * We never inject credentials here. The dashboard is a pure proxy of
 * the manager's own session.
 */

export interface MiddlewareBinding {
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface RubotEnv {
  MIDDLEWARE: MiddlewareBinding;
  RUBOT_DATA_AUTH?: string;
}

/**
 * Service Bindings ignore the URL's hostname — only the path matters.
 * We use a placeholder hostname so the URL parses cleanly.
 */
const MIDDLEWARE_ORIGIN = "https://rubot-middleware.internal";

export interface MiddlewareCallOptions {
  method?: string;
  path: string; // must start with /api/...
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

/**
 * Parse a JSON response, tolerating both `{success,data,error}` and bare
 * objects (the rubot-middleware /api/data/* routes don't wrap).
 */
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
