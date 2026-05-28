import { Hono } from "hono";
import { cors } from "hono/cors";
import { configure, rubotLogging } from "@rubot/logger";
import type { AppContext } from "./types";
import chat from "./routes/chat";
import admin from "./routes/admin";

const app = new Hono<AppContext>();

// Configure the shared logger once per isolate. trace_id is minted at the
// edge by rubotLogging() so every downstream hop (orchestrator, agents,
// middleware) can join logs on the same trace.
app.use("*", async (c, next) => {
  configure({
    service: "rubot-gateway",
    environment: c.env.ENVIRONMENT ?? "dev",
    deploymentHash: c.env.RUBOT_DEPLOYMENT_HASH ?? "local",
  });
  await next();
});

// rubotLogging mints / extracts trace_id and stamps the response
// X-Rubot-Trace-Id header. MUST run before any other middleware so the
// trace id is available to all downstream handlers via c.var.rubotCtx.
app.use("*", rubotLogging());

app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    name: "Rubot Gateway",
    status: "ok",
    routes: [
      "POST /v1/chat/completions",
      "GET  /admin/identity-bindings",
      "POST /admin/identity-bindings",
      "DELETE /admin/identity-bindings/:sender_id",
    ],
  });
});

app.route("/", chat);
app.route("/admin", admin);

export default app;
