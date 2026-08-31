#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  owner="$(stat -c '%U' "$DIR")"
  if [ -z "$owner" ] || [ "$owner" = "root" ]; then
    echo "refusing to start free-router as root" >&2
    exit 1
  fi
  if ! command -v runuser >/dev/null 2>&1; then
    echo "runuser is required to drop root; start as $owner instead" >&2
    exit 1
  fi
  exec runuser -u "$owner" -- "$DIR/start.sh" "$@"
fi

PID_FILE="$DIR/router.pid"
LOG_FILE="$DIR/router.log"

if [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "free-router already running (pid $PID)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

load_env() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env "${HOME}/.hermes/.env"
load_env "$DIR/.env"

nohup node "$DIR/server.mjs" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${FREE_ROUTER_PORT:-8787}/health" >/dev/null; then
    echo "free-router started (pid $PID, user $(id -un))"
    echo "endpoint: http://127.0.0.1:${FREE_ROUTER_PORT:-8787}/v1"
    exit 0
  fi
  sleep 0.5
done

echo "router failed to become healthy; see $LOG_FILE" >&2
exit 1
