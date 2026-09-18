# Changelog

All notable changes to the `plus` edition are recorded here.
Upstream releases (`v1.0.0`, `v1.1.0`, …) are tagged upstream; only `plus-*`
tags are cut here. Dates are commit dates (`YYYY-MM-DD`).

## [Unreleased]

### Added

- LAN access toggle in Settings replacing the host textbox: ON writes `0.0.0.0`, OFF writes `127.0.0.1`; reachable addresses (LAN IPs, loopback, hostname) listed with container-view note; warning when enabling with zero gateway keys.
- Boot guard: refuse to start on a non-loopback bind without gateway keys or with the default password.
- Login brute-force brake: 5 failures lock an IP for 5 minutes (`429` + `Retry-After`).
- Failure taxonomy: `402 payment` and `529`/`overload` kinds; capacity faults drive cooldowns only, routing/billing/credential faults are never scored.
- `script/sync-scores.mjs`: OpenRouter free-catalog report plus file-leaderboard import into overlay `baselineScores` (40-80 prior band, dry run by default).
- Epsilon-greedy exploration (`routing.explorePercent`, default 5) so cold models can earn traffic; pinned models always stay first.
- Capability-portrait bonus blended into configured scores (cap 8).
- Documented 0-100 scoring scale; pinned is a finite 150 above it.
- Scarcity tie-break (5-point band, unlimited wins) and live latency term (+2/0/−2, EWMA, 5-sample gate).
- `ctl.sh` front door: start/stop/restart, systemd one-shot install, docker (default `up -d`, `--dev` overlay), status.
- CI workflow: `npm run check` + `npm test` on push.

### Changed

- Structured layout: code in `app/`, ops in `script/`, tests in `test/`, packaging in `docker/`, single writable `data/` dir.
- `.env` files are a first-boot seed only; once an overlay exists they are ignored so UI edits always stick. Explicit process environment still wins.
- Runtime state (overlay, discovery, logs) lives under `data/`; legacy root files auto-move on boot; pid/log paths live in `data/`.
- Compose publishes `8787` on all interfaces and drops `env_file`/`environment`; settings come from `data/.env` (first boot) and the overlay.
- Login, gateway keys, provider keys, and UI copy kept from the LAN era.

### Removed

- Star History chart from the READMEs.
- Duplicate `renderServer` definition in the served page bundle.

## [plus-v1.0.0] - 2026-09-16

First `plus` release, based on upstream pre-`v1.1.0` (`88c393f`, LAN access intact).

### Added

- Structured layout replay: `app/` + `script/` + `test/` + `docker/` + `data/`, path hub with temp-dir test isolation.
- New providers default to not publishing prices.
- Failure classification: capacity faults never move the quality score; `401`s never attributed to models.

[Unreleased]: https://github.com/sitaoo/free-router/compare/plus-v1.0.0...plus
[plus-v1.0.0]: https://github.com/sitaoo/free-router/releases/tag/plus-v1.0.0
