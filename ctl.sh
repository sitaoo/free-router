#!/usr/bin/env bash
# Single front door for free-router: start/stop/restart, systemd install,
# docker, and status. Thin dispatcher only — real logic lives in script/
# and docker/. Run `./ctl.sh help` for usage.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="$REPO/script"

usage() {
  cat <<EOF
Usage: ./ctl.sh <command> [args]

  start             Start the gateway (script/start.sh)
  stop              Stop the gateway (script/stop.sh)
  restart           Stop, then start
  install-service   Install + enable + start the systemd user unit (one shot)
  docker [--dev] [compose args...]
                    Run docker compose (default: up -d).
                    --dev also loads docker/compose.override.yaml (live code).
  status            Show whether the gateway answers /health
  help              Show this message
EOF
}

cmd_status() {
  # shellcheck disable=SC1091
  . "$REPO/script/probe-port.sh"
  local port
  port="$(probe_port)" || port=8787
  local pid="" pid_file=""
  if [ -s "$REPO/data/router.pid" ]; then
    pid_file="$REPO/data/router.pid"
  elif [ -s "$REPO/router.pid" ]; then
    pid_file="$REPO/router.pid"
  fi
  if [ -n "$pid_file" ]; then
    pid="$(cat "$pid_file")"
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "free-router is running (pid $pid, port $port)"
    return 0
  fi
  echo "free-router is not running (port $port)"
  return 1
}

cmd_install_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; cannot install the service" >&2
    exit 1
  fi
  if [ "$REPO" != "$HOME/free-router" ]; then
    echo "warning: repo is at $REPO but the unit expects $HOME/free-router;" >&2
    echo "edit WorkingDirectory/ExecStart in script/free-router.service first, or say yes to continue anyway." >&2
  fi
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cp "$SCRIPT_DIR/free-router.service" "$unit_dir/free-router.service"
  systemctl --user daemon-reload
  systemctl --user enable --now free-router
  systemctl --user --no-pager status free-router || true
}

cmd_docker() {
  local files=(-f "$REPO/docker/compose.yaml")
  if [ "${1:-}" = "--dev" ]; then
    files+=(-f "$REPO/docker/compose.override.yaml")
    shift
  fi
  if [ "$#" -eq 0 ]; then
    set -- up -d
  fi
  exec docker compose "${files[@]}" "$@"
}

command="${1:-help}"
case "$command" in
  start)
    shift
    exec "$SCRIPT_DIR/start.sh" "$@"
    ;;
  stop)
    shift
    exec "$SCRIPT_DIR/stop.sh" "$@"
    ;;
  restart)
    shift
    "$SCRIPT_DIR/stop.sh" "$@"
    exec "$SCRIPT_DIR/start.sh" "$@"
    ;;
  install-service)
    cmd_install_service
    ;;
  docker)
    shift
    cmd_docker "$@"
    ;;
  status)
    cmd_status
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "unknown command: $command" >&2
    usage >&2
    exit 1
    ;;
esac
