#!/usr/bin/env bash
#
# init-project.sh — rename `rubot` to your project name across the scaffold.
#
# Run once after forking. Does a recursive find-replace on:
#   - file/dir names
#   - module/package identifiers (rubot_config → <project>_config)
#   - shell strings ("rubot", "Rubot", "RUBOT")
#
# Usage:
#   ./scripts/init-project.sh acme
#   ./scripts/init-project.sh acme-bot
#
# After running, review the diff before committing.

set -euo pipefail

NEW="${1:-}"
[ -n "$NEW" ] || { echo "usage: $0 <new-name>" >&2; exit 1; }

# Lowercase, kebab-case, snake_case, CamelCase, SCREAMING variants.
NEW_LOWER="$(echo "$NEW" | tr '[:upper:]' '[:lower:]')"
NEW_SNAKE="$(echo "$NEW_LOWER" | tr '-' '_')"
NEW_UPPER="$(echo "$NEW_SNAKE" | tr '[:lower:]' '[:upper:]')"
# CamelCase: split on - and uppercase first letter of each word
NEW_CAMEL="$(echo "$NEW_LOWER" | awk -F'-' '{ for(i=1;i<=NF;i++){ printf "%s%s", toupper(substr($i,1,1)), substr($i,2) } print "" }')"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m[init]\033[0m %s\n' "$*"; }

log "renaming: rubot → $NEW_LOWER (kebab), $NEW_SNAKE (snake), $NEW_UPPER (upper), $NEW_CAMEL (camel)"

# Sanity check
if [ "$NEW_LOWER" = "rubot" ]; then
  echo "new name same as current — nothing to do" >&2
  exit 1
fi

# 1. Content substitution. Order: longest first to avoid partial overwrites.
log "substituting in file contents"
find . \
  -type f \
  ! -path './.git/*' ! -path './node_modules/*' ! -path './.venv/*' \
  ! -path './**/__pycache__/*' ! -path './**/dist/*' ! -path './**/.wrangler/*' \
  ! -name 'init-project.sh' \
  -exec sed -i \
    -e "s/Rubot/$NEW_CAMEL/g" \
    -e "s/RUBOT/$NEW_UPPER/g" \
    -e "s/rubot_/${NEW_SNAKE}_/g" \
    -e "s/rubot/$NEW_LOWER/g" \
    {} +

# 2. Rename directories first (deepest to shallowest), then files.
log "renaming dirs"
find . -depth -type d -name '*rubot*' \
  ! -path './.git/*' ! -path './node_modules/*' ! -path './.venv/*' \
  | while read -r d; do
      new_d="$(echo "$d" | sed -e "s/rubot_/${NEW_SNAKE}_/g" -e "s/rubot/$NEW_LOWER/g")"
      [ "$d" != "$new_d" ] && mv "$d" "$new_d"
    done

log "renaming files"
find . -type f -name '*rubot*' \
  ! -path './.git/*' ! -path './node_modules/*' ! -path './.venv/*' \
  | while read -r f; do
      new_f="$(echo "$f" | sed -e "s/rubot_/${NEW_SNAKE}_/g" -e "s/rubot/$NEW_LOWER/g")"
      [ "$f" != "$new_f" ] && mv "$f" "$new_f"
    done

log "done."
log ""
log "review the diff:"
log "  git diff --stat"
log "  git diff"
