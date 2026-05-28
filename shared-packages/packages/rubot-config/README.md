# rubot-config

Unified LLM/runtime configuration and base agent for rubot specialist agents.

Centralises provider, model, and `ModelSettings` parameters in
[`rubot_config/agents.yaml`](rubot_config/agents.yaml). Runtime overrides come
from environment variables, so every deployed service can swap models or tune
parameters without a rebuild.

---

## Adding a new agent (3 steps)

1. **Subclass `BaseAgent`** in your specialist and set `agent_name`:

   ```python
   from rubot_config import BaseAgent
   from app.agent.deps import AgentDeps

   class MyAgent(BaseAgent):
       agent_name = "my-agent"

   agent = MyAgent(deps_type=AgentDeps, output_type=str)

   @agent.tool
   async def my_tool(ctx, arg: str) -> str:
       ...
   ```

2. **(Optional) Add a YAML block** in `rubot_config/agents.yaml` if the
   defaults are not appropriate:

   ```yaml
   agents:
     my-agent:
       provider: anthropic
       model: claude-sonnet-4-5
       max_tokens: 8000
   ```

   If omitted, the agent boots using the top-level `defaults:` block and a
   warning is logged.

3. **Set env vars** to override at deploy time. Agent-name normalisation:
   upper-case and hyphens → underscores. `my-agent` ⇒ prefix `AGENT_MY_AGENT_`.

   ```
   AGENT_MY_AGENT_MODEL=gpt-4o
   AGENT_MY_AGENT_TEMPERATURE=0.2
   AGENT_MY_AGENT_PROVIDER=openai
   ```

Provider-credential env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are
resolved by Pydantic AI directly.

---

## Merge order (last wins)

1. `defaults:` block in `agents.yaml`
2. Per-agent block in `agents.yaml`
3. Env vars matching `AGENT_{NAME}_{PARAM}`

---

## Custom endpoints (OpenRouter, local proxies, …)

```yaml
agents:
  my-agent:
    provider: openai
    model: gpt-4o-mini
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
```

When `api_key_env` is set, the referenced env var **must** be populated —
boot fails loud otherwise.

---

## Parameter pass-through

Standard `ModelSettings` fields (`temperature`, `max_tokens`, `top_p`,
`timeout`, `seed`, `thinking`, …) pass through unchanged. Any other key is
auto-prefixed with the provider name following Pydantic AI's convention:

```yaml
reasoning_effort: high   # ⇒ openai_reasoning_effort: high
```

It is the operator's job to ensure the parameters are accepted by the chosen
provider + model.

---

## Local testing

```bash
pip install -e '.[dev]'
pytest
```
