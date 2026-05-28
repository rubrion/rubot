#!/bin/sh
set -e

INTERNAL_PORT=${PORT:-8000}

# Optional: fetch MLP model at startup if MLP_MODEL_URL is set
if [ -n "$MLP_MODEL_URL" ] && [ -n "$MLP_MODEL_PATH" ]; then
  mkdir -p "$(dirname "$MLP_MODEL_PATH")"
  REMOTE_ETAG=$(curl -fsSI "$MLP_MODEL_URL" 2>/dev/null | awk 'tolower($1)=="etag:"{print $2}' | tr -d '"\r\n')
  LOCAL_ETAG=""
  [ -f "${MLP_MODEL_PATH}.etag" ] && LOCAL_ETAG=$(cat "${MLP_MODEL_PATH}.etag")
  if [ ! -f "$MLP_MODEL_PATH" ] || [ "$REMOTE_ETAG" != "$LOCAL_ETAG" ]; then
    echo "[guardrails] fetching MLP model"
    curl -fsSL "$MLP_MODEL_URL" -o "${MLP_MODEL_PATH}.tmp"
    mv "${MLP_MODEL_PATH}.tmp" "$MLP_MODEL_PATH"
    [ -n "$REMOTE_ETAG" ] && echo "$REMOTE_ETAG" > "${MLP_MODEL_PATH}.etag"
  fi
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${INTERNAL_PORT}"
