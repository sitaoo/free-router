#!/usr/bin/env bash
# Shared helper: resolve the probe port without sourcing .env files.
# Stale file values must never leak into the environment and veto overlay
# settings, so this reads the overlay (data/ or legacy root) and the tracked
# base directly. Expects REPO to be set by the caller. Prints the port.
# Order: explicit $FREE_ROUTER_PORT wins, then overlay, then tracked base.
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
