import type { MiddlewareHandler } from "hono";
import { setContext } from "./context";
import { getLogger } from "./logger";

const TRACE_HEADER = "x-rubot-trace-id";
const TRACEPARENT_HEADER = "traceparent";
const TENANT_HEADER = "x-tenant-id";
const SESSION_HEADER = "x-chat-source-session-id";
const SENDER_HEADER = "x-chat-source-sender-id";

function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function extractTraceId(headers: Headers): string | null {
  const explicit = headers.get(TRACE_HEADER);
  if (explicit && explicit.length === 32) return explicit;

  const tp = headers.get(TRACEPARENT_HEADER);
  if (tp) {
    const parts = tp.split("-");
    if (parts.length >= 2 && parts[1].length === 32) return parts[1];
  }
  return null;
}

export const HEADER_NAMES = {
  TRACE: TRACE_HEADER,
  TRACEPARENT: TRACEPARENT_HEADER,
  TENANT: TENANT_HEADER,
  SESSION: SESSION_HEADER,
  SENDER: SENDER_HEADER,
} as const;

export function rubotLogging(): MiddlewareHandler {
  const logger = getLogger("middleware");

  return async (c, next) => {
    const traceId =
      extractTraceId(c.req.raw.headers) || generateTraceId();

    const ctx = {
      traceId,
      tenantId: c.req.header(TENANT_HEADER) ?? null,
      chatSourceSessionId: c.req.header(SESSION_HEADER) ?? null,
      senderId: c.req.header(SENDER_HEADER) ?? null,
    };

    setContext(c, ctx);
    c.set("rubotCtx", ctx);

    const log = logger.withContext(c);
    const start = Date.now();
    log.info("http.request.received", `${c.req.method} ${c.req.path}`);

    await next();

    const elapsed = Date.now() - start;
    log.info(
      "http.request.completed",
      `${c.req.method} ${c.req.path} -> ${c.res.status}`,
      { extra: { elapsed_ms: elapsed, status_code: c.res.status } },
    );

    c.res.headers.set(TRACE_HEADER, traceId);
  };
}
