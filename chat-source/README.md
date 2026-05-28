# chat-source

Placeholder for the external messaging adapter that feeds rubot.

`rubot-gateway` is OpenAI-compatible (`POST /v1/chat/completions`). Anything
that can hit an HTTP endpoint with a Bearer token can be a chat-source:

- WhatsApp via Twilio / Meta Cloud API
- Telegram bot
- Slack app
- iMessage relay
- Discord bot
- a web chat widget
- a CLI script (for testing)
- a workflow tool (n8n, Make, Zapier)

The adapter does three things:

1. Receive a user message from its channel.
2. POST to `${RUBOT_GATEWAY_URL}/v1/chat/completions` with:
   - `Authorization: Bearer ${GATEWAY_API_KEY}`
   - `X-Chat-Source-Session-Id: <unique-per-conversation>`
   - `X-Chat-Source-Sender-Id: <unique-per-end-user>` (phone, email, slack id, …)
   - Body: `{ messages: [{role, content}], model, stream }`
3. Forward the response back to the channel.

The gateway mints a `trace_id` per request and threads it through every
downstream service (orchestrator, agents, middleware).

## Config example

`chat-source.json.example` is a config blueprint. Adapt the field names to
your chosen adapter. The key parts:

```jsonc
{
  "gateway": {
    "url": "${RUBOT_GATEWAY_URL}",
    "auth": {
      "type": "bearer",
      "token_env": "GATEWAY_API_KEY"
    }
  },
  "channels": {
    "default": {
      "type": "<whatsapp | telegram | slack | …>",
      "allow_senders": ["+5511999999999", "@username", "U01ABC..."]
    }
  },
  "session": {
    "reset_triggers": ["/new", "/reset"],
    "idle_minutes": 120,
    "daily_reset_hour_utc": 7
  }
}
```

## OpenClaw users

OpenClaw with a custom plugin to stamp
`x-openclaw-session-id` + `x-openclaw-sender-phone` headers. To use OpenClaw
with rubot, point the plugin at the rubot equivalents:

```jsonc
{
  "plugins": [
    "whatsapp",
    "acpx",
    {
      "name": "rubot-identity",
      "session_header": "x-chat-source-session-id",
      "sender_header": "x-chat-source-sender-id"
    }
  ]
}
```

## See also

- `rubot/workers/rubot-gateway/README.md` — gateway env vars
- `rubot/docs/architecture.md` — full request lifecycle
