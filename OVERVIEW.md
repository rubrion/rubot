# Rubot

Rubot is a multi-tenant, LLM-driven chat-agent scaffold built on Cloudflare Workers (gateway + middleware) and Railway (Python agents). Specialist agents are forked from a common template, registered in an orchestrator, and routed by an LLM planner — all connected through a short-lived, HMAC-signed bearer chain that never exposes long-lived credentials to the model.

**Services:**

| Service | Tech | Where |
|---------|------|-------|
| `rubot-gateway` | TypeScript / Hono | Cloudflare Workers |
| `rubot-middleware` | TypeScript / Hono + D1 | Cloudflare Workers |
| `rubot-orchestrator` | Python / FastAPI | Railway |
| `rubot-agent-*` | Python / pydantic_ai | Railway |
| `rubot-client` | Astro SSR | Cloudflare Workers |
| `rubot-superadmin` | Astro SSR | Cloudflare Workers |

**Two deployment modes:**

- **Bearer mode** (`RUBOT_DATA_AUTH=bearer`) — full multi-tenant identity: manager accounts, PIN-based sender→tenant binding, HMAC-signed short-lived data bearers, per-tenant agent toggles.
- **Open mode** (`RUBOT_DATA_AUTH=open`) — auth chain bypassed; all services share one implicit tenant. Suitable for single-tenant or development deployments.

**Built with rubot:**

| Product | What | Repo |
|---------|------|------|
| brad | Marketing-consultant agent suite — briefs, banners, posts, insights, grounded in a per-tenant brand kit | private |

Built something on rubot? Open a PR adding it here.

Recommended reading order: [Architecture](architecture.md) → [Local Development](local-development.md) → [Creating a New Agent](creating-new-agent.md) → [Deploy](deploy.md). [Env Vars](env-vars.md) is a reference cheat-sheet.
