# rubot-orchestrator

LLM-planner router that sits between the rubot gateway and the specialist
agents. Every `POST /v1/chat/completions` from the gateway lands here, gets
routed to one or more specialist agents, and the responses are merged into a
single OpenAI-shaped reply.

The orchestrator does **not** hard-code agent names. Specialists are
discovered dynamically from the registry env var, and their semantic
capabilities are fetched from each agent's `GET /v1/capabilities` endpoint
at runtime (cached). To add a new agent you only need to register its URL.

## Endpoints

| Method | Path                  | Description                                         |
|-------:|-----------------------|-----------------------------------------------------|
|   GET  | `/`                   | Health check / version                              |
|  POST  | `/v1/chat/completions`| OpenAI-shaped chat completion, fans out to agents   |

The chat-completions endpoint expects:

- `Authorization: Bearer <GATEWAY_API_KEY>` (inbound gateway auth)
- `X-Tenant-Id: <tenant>` (required)
- `X-Rubot-Data-Bearer: <tenant-secret>` (required — forwarded to middleware
  for the connections preflight and to specialist agents)
- Optional propagated headers handled by the logging middleware:
  `X-Rubot-Trace-Id`, `X-Chat-Source-Session-Id`, `X-Chat-Source-Sender-Id`.

## Request flow

1. **Preflight** — `GET {MIDDLEWARE_URL}/api/data/{tenantId}/connections`
   returns which data providers are connected/active for the tenant.
2. **Capabilities** — for each registered agent whose id matches an
   available provider, fetch `GET {agent_url}/v1/capabilities` (cached for
   30 minutes).
3. **Plan** — call the planner LLM with the conversation history + the
   capability JSON. The model returns a `RoutingPlan` (strategy + slices).
4. **Dispatch** — call each slice's agent in parallel via
   `POST {agent_url}/v1/chat/completions`.
5. **Merge** — combine the textual responses into a single OpenAI envelope.

## Environment variables

| Name                    | Purpose                                                                 |
|-------------------------|-------------------------------------------------------------------------|
| `GATEWAY_API_KEY`       | Inbound bearer — gateway must present this on every request.            |
| `ORCHESTRATOR_API_KEY`  | Outbound bearer — specialist agents validate this on incoming calls.    |
| `AGENT_REGISTRY_JSON`   | JSON map of `{agent_id: base_url}` — the only agent registry.           |
| `MIDDLEWARE_URL`        | Base URL of rubot-middleware (used for the connections preflight).      |
| `PLANNER_BASE_URL`      | OpenAI-compatible base URL for the routing LLM.                         |
| `PLANNER_API_KEY`       | API key for the routing LLM.                                            |
| `PLANNER_MODEL`         | Model id (default `gpt-4o-mini`).                                       |
| `PLANNER_TIMEOUT_SECONDS` | HTTP timeout for the planner LLM call.                                |

Example `AGENT_REGISTRY_JSON`:

```json
{
  "example-provider": "https://example-agent.internal",
  "conversational": "https://conversational-agent.internal"
}
```

## Adding a new agent

1. Deploy your specialist agent (fork `rubot-agent-template`) and make sure
   it exposes `GET /v1/capabilities` returning the schema:
   ```json
   { "schema_version": "1", "source_id": "<your_id>", "name": "…", "summary": "…" }
   ```
2. Register its URL in the orchestrator's `AGENT_REGISTRY_JSON` env var.
3. No code change required in the orchestrator — capabilities are fetched
   dynamically and passed to the planner LLM, which decides when to route to
   the new agent.

See `docs/creating-new-agent.md` for the full walk-through.

## Local dev

```sh
# from the rubot/ root
pip install ./shared-packages/packages/rubot-logger ./shared-packages/packages/rubot-config
pip install -e ./agents/rubot-orchestrator
cd agents/rubot-orchestrator
./start.sh
```

## Tests

```sh
cd agents/rubot-orchestrator
pip install -e ".[dev]"
pytest -q
```
