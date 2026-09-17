#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DIR")"
DATA_DIR="$REPO/data"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"

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

PID_FILE="$DATA_DIR/router.pid"

# Legacy upgrade: root router.log moves into data/logs once (pid files are
# resolved read-only below; the new pid is always written to data/).
if [ -f "$REPO/router.log" ] && [ ! -f "$LOG_DIR/router.log" ]; then
  mv "$REPO/router.log" "$LOG_DIR/router.log"
fi

# New home first, repo-root legacy second.
find_pid_file() {
  if [ -s "$DATA_DIR/router.pid" ]; then echo "$DATA_DIR/router.pid"; return 0; fi
  if [ -s "$REPO/router.pid" ]; then echo "$REPO/router.pid"; return 0; fi
  return 1
}

if FOUND_PID_FILE="$(find_pid_file)"; then
  PID="$(cat "$FOUND_PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "free-router already running (pid $PID)"
    exit 0
  fi
  rm -f "$DATA_DIR/router.pid" "$REPO/router.pid"
fi

# Probe port resolution (no .env sourcing here: stale file values must not
# leak into the server environment and veto overlay settings). Order:
# explicit env wins, then overlay (data/ or legacy root), then tracked base.
probe_port() {
  if [ -n "${FREE_ROUTER_PORT:-}" ]; then printf '%s' "$FREE_ROUTER_PORT"; return 0; fi
  FR_REPO="$REPO" node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const repo = process.env.FR_REPO;
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
    const overlay = read(path.join(repo, "data", "config.local.json"));
    if (!("port" in overlay)) Object.assign(overlay, read(path.join(repo, "config.local.json")));
    const base = read(path.join(repo, "app", "config", "config.json"));
    const port = Number(overlay.port ?? base.port ?? 8787);
    process.stdout.write(String(Number.isFinite(port) && port > 0 ? port : 8787));
  '
}

PROBE_PORT="$(probe_port)" || PROBE_PORT=8787

nohup node "$REPO/app/server.mjs" >>"$LOG_DIR/router.log" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PROBE_PORT}/health" >/dev/null; then
    echo "free-router started (pid $PID, user $(id -un))"
    echo "endpoint: http://127.0.0.1:${PROBE_PORT}/v1"
    exit 0
  fi
  sleep 0.5
done

echo "router failed to become healthy; run: node app/server.mjs" >&2
exit 1
