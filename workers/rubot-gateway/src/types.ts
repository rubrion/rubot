import type { RequestContext } from "@rubot/logger";

export interface Bindings {
  // D1
  DB: D1Database;
  // KV
  PROVISIONING: KVNamespace;
  // Service binding to rubot-middleware
  MIDDLEWARE: Fetcher;

  // Plaintext vars
  ENVIRONMENT?: string;
  RUBOT_DEPLOYMENT_HASH?: string;
  ORCHESTRATOR_URL: string;
  CALLBACK_URL?: string;
  CF_ACCESS_CLIENT_ID?: string;
  STAGING_STATIC_TENANT?: string;
  RUBOT_DATA_AUTH?: string;
  RUBOT_OPEN_TENANT?: string;

  // Secrets (via `wrangler secret put <NAME>`)
  GATEWAY_API_KEY: string;
  ADMIN_API_KEY: string;
  BEARER_SIGNING_SECRET: string;
  MIDDLEWARE_API_KEY?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  STAGING_STATIC_BEARER?: string;
}

export type AppContext = {
  Bindings: Bindings;
  Variables: {
    rubotCtx: RequestContext;
  };
};

export interface IdentityBindingRow {
  sender_id: string;
  tenant_id: string;
  created_at: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  user?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}
