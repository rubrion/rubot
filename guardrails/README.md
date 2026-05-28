# Rubot Guardrails

Input/output safety pipeline that wraps the orchestrator's `/v1/chat/completions` endpoint.

## Pipeline stages

1. **Input regex** -- banned-word exact match (`input/regex/banned_words.txt`)
2. **Input MLP** -- ML classifier (legitimate vs illegitimate) via OpenAI embeddings + scikit-learn
3. **Agent call** -- transparent proxy to the orchestrator
4. **Output LLM** -- multi-pillar LLM-as-judge scoring (configurable pillars: `attack`, `nsfw`, `privacy`, `security`, `toxicity`, `bias`)

Short-circuit behaviour: if input is blocked the agent is never called; if output is blocked the agent response is replaced with a safe message.

## Configuration

Edit `config.json` to toggle stages, set thresholds, choose output pillars, and customise block messages.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GATEWAY_API_KEY` | yes | Bearer token for authenticating inbound requests |
| `ORCHESTRATOR_URL` | yes | Base URL of the orchestrator service |
| `OPENAI_API_KEY` | yes | Used by both MLP embeddings and output LLM judge |
| `MLP_MODEL_URL` | no | Remote URL to fetch the MLP model at startup |
| `MLP_MODEL_PATH` | no | Local path where the MLP model is stored |
| `GUARDRAILS_CONFIG_PATH` | no | Override path for config.json |
| `PORT` | no | Listening port (default 8000) |

## Running locally

```bash
pip install -e .
uvicorn app.main:app --reload --port 8000
```

## Docker

Build from the `rubot/` root:

```bash
docker build -f guardrails/Dockerfile -t rubot-guardrails .
docker run -p 8000:8000 --env-file .env rubot-guardrails
```
