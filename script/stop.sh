#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  owner="$(stat -c '%U' "$DIR")"
  if [ -n "$owner" ] && [ "$owner" != "root" ] && command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$owner" -- "$DIR/stop.sh" "$@"
  fi
fi

REPO="$(dirname "$DIR")"
DATA_DIR="$REPO/data"

# New home first, repo-root legacy second.
find_pid_file() {
  if [ -s "$DATA_DIR/router.pid" ]; then echo "$DATA_DIR/router.pid"; return 0; fi
  if [ -s "$REPO/router.pid" ]; then echo "$REPO/router.pid"; return 0; fi
  return 1
}

if ! PID_FILE="$(find_pid_file)"; then
  echo "free-router is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$DATA_DIR/router.pid" "$REPO/router.pid"
  echo "free-router is not running (removed stale pid file)"
  exit 0
fi

# The pid may have been reused after a crash: only signal a process whose
# command line is actually free-router, never whatever else got that pid.
if [ -r "/proc/$PID/cmdline" ] && ! tr '\0' ' ' <"/proc/$PID/cmdline" | grep -q "app/server.mjs"; then
  rm -f "$DATA_DIR/router.pid" "$REPO/router.pid"
  echo "pid $PID is not free-router (removed stale pid file)" >&2
  exit 1
fi

# SIGTERM first: the server drains in-flight requests for up to 8 s, so give
# it longer than that before escalating, then insist.
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 50); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$PID" 2>/dev/null; then
  echo "free-router (pid $PID) ignored SIGTERM for 10s; sending SIGKILL" >&2
  kill -9 "$PID" 2>/dev/null || true
  sleep 0.5
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "free-router (pid $PID) is still running; leaving $PID_FILE in place" >&2
  exit 1
fi

rm -f "$DATA_DIR/router.pid" "$REPO/router.pid"
echo "free-router stopped"
