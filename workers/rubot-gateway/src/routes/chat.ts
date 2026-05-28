import { Hono } from "hono";
import type { Context } from "hono";
import { HEADER_NAMES } from "@rubot/logger";
import type { AppContext, ChatCompletionRequest, ChatMessage } from "../types";
import { lookupSessionBearer } from "../lib/session";

// Strip identity markers the user may have typed into their message so the
// downstream LLM never sees tenant/sender references that could be used for
// prompt-injection-driven pivots. Defense-in-depth — identity is bound
// out-of-band via the session_bearers row.
const IDENTITY_MARKERS: RegExp[] = [
  /sender_id[:\s]+[A-Za-z0-9_\-.+@]+\s*/gi,
  /tenant_id[:\s]+[A-Za-z0-9_\-.]+\s*/gi,
  /tenant[:\s]+[A-Za-z0-9_\-.]+\s*/gi,
];
const DEBUG_LOGS = true;

const chat = new Hono<AppContext>();

function normalizeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  if (typeof content === "object") {
    if ("text" in (content as Record<string, unknown>)) {
      const t = (content as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    }
    return JSON.stringify(content);
  }
  return String(content);
}

function stripIdentityMarkers(text: string): string {
  let out = text;
  for (const rx of IDENTITY_MARKERS) out = out.replace(rx, "");
  return out.trim();
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((m) => ({
      ...m,
      content: stripIdentityMarkers(normalizeContentToText(m.content)),
    }))
    .filter((m) => typeof m.role === "string" && m.role.length > 0);
}

// Gate inbound traffic to our configured chat-source adapter.
chat.use("/v1/chat/completions", async (c, next) => {
  const key = c.env.GATEWAY_API_KEY;
  if (!key) return c.json({ error: "server misconfigured: GATEWAY_API_KEY not set" }, 500);

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${key}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
});

function completionEnvelope(content: string) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: "rubot-gateway",
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const FALLBACK_MESSAGE =
  "Could not generate a complete response right now. Please try again shortly.";

function makeNormalizedCompletion(content: string, status = 200): Response {
  const safe = (content || "").trim() || FALLBACK_MESSAGE;
  return new Response(JSON.stringify(completionEnvelope(safe)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStreamingCompletion(content: string, status = 200): Response {
  const safe = (content || "").trim() || FALLBACK_MESSAGE;
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunkStart = {
    id,
    object: "chat.completion.chunk",
    created,
    model: "rubot-gateway",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  const chunkContent = {
    id,
    object: "chat.completion.chunk",
    created,
    model: "rubot-gateway",
    choices: [{ index: 0, delta: { content: safe }, finish_reason: null }],
  };
  const chunkEnd = {
    id,
    object: "chat.completion.chunk",
    created,
    model: "rubot-gateway",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  const sse =
    `data: ${JSON.stringify(chunkStart)}\n\n` +
    `data: ${JSON.stringify(chunkContent)}\n\n` +
    `data: ${JSON.stringify(chunkEnd)}\n\n` +
    "data: [DONE]\n\n";
  return new Response(sse, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function buildUnlinkedMessage(callbackUrl: string, senderId: string | null): string {
  const base = (callbackUrl || "").replace(/\/$/, "");
  const url = senderId ? `${base}?sender=${encodeURIComponent(senderId)}` : base;
  return `Unrecognized device. Please access ${url} to link your account.`;
}

function respondUnlinked(callbackUrl: string, senderId: string | null, stream: boolean): Response {
  const content = buildUnlinkedMessage(callbackUrl, senderId);
  return stream ? makeStreamingCompletion(content) : makeNormalizedCompletion(content);
}

chat.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json<ChatCompletionRequest>();
  const requestedStream = body.stream === true;
  const callbackUrl = c.env.CALLBACK_URL ?? "";

  if ((c.env.RUBOT_DATA_AUTH || "bearer") === "open") {
    const tenantId = c.env.RUBOT_OPEN_TENANT || "default";
    if (DEBUG_LOGS) {
      console.log(`[gateway] open-mode tenant_id="${tenantId}"`);
    }
    return forwardToOrchestrator(c, body, requestedStream, tenantId, "");
  }

  const sessionId = c.req.header(HEADER_NAMES.SESSION)?.trim() || "";
  const senderId = c.req.header(HEADER_NAMES.SENDER)?.trim() || "";

  // No session header → can't resolve identity at all. Return the unlinked
  // template so the user can complete the link flow manually.
  if (!sessionId) {
    if (DEBUG_LOGS) {
      console.log(
        `[gateway] no ${HEADER_NAMES.SESSION} — returning unlinked-device response`,
      );
    }
    return respondUnlinked(callbackUrl, null, requestedStream);
  }

  const binding = await lookupSessionBearer(
    c.env.DB,
    sessionId,
    c.env.MIDDLEWARE,
    c.env.MIDDLEWARE_API_KEY ?? "",
    senderId,
    c.env.STAGING_STATIC_BEARER ?? "",
    c.env.STAGING_STATIC_TENANT ?? "",
  );

  if (!binding) {
    if (DEBUG_LOGS) {
      console.log(
        `[gateway] session_id="${sessionId}" has no binding — returning unlinked (sender_id="${senderId}")`,
      );
    }
    return respondUnlinked(callbackUrl, senderId || null, requestedStream);
  }

  if (DEBUG_LOGS) {
    console.log(
      `[gateway] session-id path session_id="${sessionId}" tenant_id="${binding.tenantId}"`,
    );
  }
  return forwardToOrchestrator(c, body, requestedStream, binding.tenantId, binding.bearer);
});

async function forwardToOrchestrator(
  c: Context<AppContext>,
  body: ChatCompletionRequest,
  requestedStream: boolean,
  tenantId: string,
  scopedBearer: string,
): Promise<Response> {
  const orchestratorUrl = (c.env.ORCHESTRATOR_URL ?? "").replace(/\/$/, "");
  const targetUrl = `${orchestratorUrl}/v1/chat/completions`;

  const forwardBody: Record<string, unknown> = {
    model: body.model ?? "rubot",
    messages: normalizeMessages(body.messages ?? []),
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    stream: false,
  };

  // trace_id is minted at the edge by rubotLogging() middleware (see index.ts)
  // and stashed under c.var.rubotCtx. Forward it so the orchestrator and
  // every downstream hop emit logs that join up on the same trace.
  const ctx = c.var.rubotCtx;
  const traceId = ctx?.traceId ?? "";

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${c.env.GATEWAY_API_KEY}`,
    "X-Tenant-Id": tenantId,
    "X-Rubot-Trace-Id": traceId,
  };
  if (scopedBearer) {
    upstreamHeaders["X-Rubot-Data-Bearer"] = scopedBearer;
  }
  if (c.env.CF_ACCESS_CLIENT_ID) {
    upstreamHeaders["CF-Access-Client-Id"] = c.env.CF_ACCESS_CLIENT_ID;
    upstreamHeaders["CF-Access-Client-Secret"] = c.env.CF_ACCESS_CLIENT_SECRET ?? "";
  }

  if (DEBUG_LOGS) {
    const msgCount = Array.isArray(forwardBody.messages)
      ? (forwardBody.messages as unknown[]).length
      : 0;
    console.log(
      `[gateway] forward tenant_id="${tenantId}" messages=${msgCount} requested_stream=${requestedStream} trace_id="${traceId}" bearer=mbr.*`,
    );
  }

  const upstream = await fetch(targetUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(forwardBody),
  });

  return forwardUpstream(upstream, requestedStream);
}

async function forwardUpstream(upstream: Response, stream: boolean): Promise<Response> {
  const result = await upstream.text();

  try {
    const payload = JSON.parse(result) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      [key: string]: unknown;
    };

    if (Array.isArray(payload.choices) && payload.choices.length > 0) {
      const first = payload.choices[0];
      const content = first?.message?.content;
      let normalized = "";
      if (typeof content === "string") {
        normalized = content.trim();
      } else if (Array.isArray(content)) {
        normalized = content
          .map((p: unknown) => {
            if (typeof p === "string") return p;
            if (p && typeof p === "object" && "text" in p) {
              const t = (p as { text?: unknown }).text;
              return typeof t === "string" ? t : "";
            }
            return "";
          })
          .join(" ")
          .trim();
      }
      if (DEBUG_LOGS) {
        const len = typeof content === "string" ? content.length : -1;
        console.log(
          `[gateway] upstream status=${upstream.status} choices=${payload.choices.length} content_len=${len} normalized_len=${normalized.length}`,
        );
      }
      if (stream) return makeStreamingCompletion(normalized);
      return makeNormalizedCompletion(normalized);
    }

    if (DEBUG_LOGS) {
      console.log(`[gateway] upstream status=${upstream.status} payload_without_choices=true`);
    }
    if (stream) return makeStreamingCompletion("");
    return makeNormalizedCompletion("");
  } catch {
    if (DEBUG_LOGS) {
      console.log(`[gateway] upstream status=${upstream.status} non_json_payload=true`);
    }
    if (stream) return makeStreamingCompletion(result);
    return makeNormalizedCompletion(result);
  }
}

export default chat;
