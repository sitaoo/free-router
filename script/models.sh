#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  owner="$(stat -c '%U' "$DIR")"
  if [ -n "$owner" ] && [ "$owner" != "root" ] && command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$owner" -- "$DIR/models.sh" "$@"
  fi
fi

# NOTE: no .env sourcing here on purpose. list-models.mjs loads seed files
# itself on first boot and ignores them once an overlay exists, so sourcing
# here would let stale file values veto overlay settings in its environment.
exec node "$(dirname "$DIR")/app/cli/list-models.mjs" "$@"
