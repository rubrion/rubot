#!/bin/sh
set -e

# rubot-conversational is reached over private networking by the
# orchestrator. No public port is exposed from this container.
INTERNAL_PORT=8000

exec uvicorn app.main:app --host 0.0.0.0 --port "${INTERNAL_PORT}"
