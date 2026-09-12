#!/usr/bin/env bash
# One-time move from the flat layout (<= Sep 2026) to app/data/script dirs.
# Safe to run twice; never overwrites existing files in data/.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DIR")"
DATA_DIR="$REPO/data"
mkdir -p "$DATA_DIR"

move_if_missing() {
  local source="$1"
  local target="$2"
  if [ ! -f "$source" ]; then
    return 0
  fi
  if [ -f "$target" ]; then
    echo "keep  $target (already exists, left $source alone)"
    return 0
  fi
  mv "$source" "$target"
  echo "moved $source -> $target"
}

move_if_missing "$REPO/config.local.json" "$DATA_DIR/config.local.json"
move_if_missing "$REPO/discovered-free-models.json" "$DATA_DIR/discovered-free-models.json"
move_if_missing "$REPO/.env" "$DATA_DIR/.env"
move_if_missing "$REPO/router.log" "$DATA_DIR/router.log"
move_if_missing "$REPO/router.pid" "$DATA_DIR/router.pid"

echo "done. Start with ./script/start.sh (or docker compose up -d)."
