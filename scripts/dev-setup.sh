#!/usr/bin/env bash
#
# dev-setup.sh — bootstrap local development for any rubot Python agent.
#
# What it does:
#   1. Creates a Python venv at .venv (if missing)
#   2. Installs rubot-logger + rubot-config as editable installs
#   3. Optionally installs a specific agent in editable mode
#
# Usage:
#   ./scripts/dev-setup.sh                       # shared packages only
#   ./scripts/dev-setup.sh rubot-agent-template  # also install one agent
#   ./scripts/dev-setup.sh rubot-orchestrator    # planner/router
#
# Env vars:
#   PYTHON_BIN  — python executable (default: python3)

set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"
AGENT="${1:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m[dev-setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[dev-setup]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. venv
if [ ! -d ".venv" ]; then
  log "creating venv at .venv ($PYTHON_BIN)"
  "$PYTHON_BIN" -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate
log "venv active: $(which python)"

pip install --quiet --upgrade pip

# 2. editable installs of shared packages
log "installing rubot-logger (editable)"
pip install --quiet -e "./shared-packages/packages/rubot-logger[fastapi,dev]"

log "installing rubot-config (editable)"
pip install --quiet -e "./shared-packages/packages/rubot-config[dev]"

# 3. optional agent install
if [ -n "$AGENT" ]; then
  AGENT_DIR="agents/$AGENT"
  [ -d "$AGENT_DIR" ] || die "agent dir not found: $AGENT_DIR"
  log "installing $AGENT (editable, with dev extras)"
  pip install --quiet -e "./$AGENT_DIR[dev]" || pip install --quiet -e "./$AGENT_DIR"
fi

log "done."
log ""
log "next steps:"
log "  source .venv/bin/activate"
if [ -n "$AGENT" ]; then
  log "  cd agents/$AGENT && uvicorn app.main:app --reload --port 8000"
else
  log "  pip install -e ./agents/<agent>[dev]   # install an agent"
fi
log ""
log "edit any file in shared-packages/packages/* and changes apply immediately."
