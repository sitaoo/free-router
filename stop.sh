#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  owner="$(stat -c '%U' "$DIR")"
  if [ -n "$owner" ] && [ "$owner" != "root" ] && command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$owner" -- "$DIR/stop.sh" "$@"
  fi
fi

PID_FILE="$DIR/router.pid"

if [ ! -s "$PID_FILE" ]; then
  echo "free-router is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.2
  done
fi
rm -f "$PID_FILE"
echo "free-router stopped"
