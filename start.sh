#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/router.pid"
LOG_FILE="$DIR/router.log"

if [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "openrouter-free-router already running (pid $PID)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [ -f "$HOME/.hermes/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$HOME/.hermes/.env"
  set +a
fi

nohup node "$DIR/server.mjs" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${FREE_ROUTER_PORT:-8787}/health" >/dev/null; then
    echo "openrouter-free-router started (pid $PID)"
    echo "endpoint: http://127.0.0.1:${FREE_ROUTER_PORT:-8787}/v1"
    exit 0
  fi
  sleep 0.5
done

echo "router failed to become healthy; see $LOG_FILE" >&2
exit 1
