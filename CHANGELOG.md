# Changelog

All notable changes to the `plus` edition are recorded here.
Upstream releases (`v1.0.0`, `v1.1.0`, …) are tagged upstream; only `plus-*`
tags are cut here. Dates are commit dates (`YYYY-MM-DD`).

## [Unreleased]

### Added

- `POST /v1/responses`: the gateway now speaks the OpenAI Responses API on the same routes, keys, quota, cooldown, and usage counters as chat completions. Requests and answers are translated in both directions (`input`, `instructions`, `tools`, `text.format`, `reasoning.effort`, `max_output_tokens`), streaming emits the standard `response.*` event sequence, and custom tools round-trip as `custom_tool_call`. Stateful fields (`store`, `previous_response_id`, `conversation`, `background`, `prompt`, `item_reference`) are refused with a 400 instead of being ignored.
- Free-tier probing now runs for every price-free catalog by default (Gemini, TokenRouter, B.AI) and a new HashNeuron provider is shipped; a probe that returns a positive `usage.cost`/`credits` is treated as billed and kept out of routes.
- Cached free verdicts are re-adopted into discovery after a state-file loss, without spending another probe.
- Context-window pre-filter: estimated input plus requested output skips a candidate only when its published `context_length` is clearly too small; unknown limits and inline media keep it.
- SWE-bench Verified prior (shipped `app/data/swe-bench.json`) ranks models with no config anchor, `baselineScores` entry, or evaluation score; `/health`, the web UI, and `models.sh` report the source as `scoreSource`.
- Provider presets for Groq, Cerebras, Mistral, and Hugging Face, plus a `probeFreeTier` switch in the create form and each provider's advanced settings; the toggle applies without a restart.
- Discovery **Run now** bypasses the interval and runs in the background; an empty discovery route offers its live ranking as one-click draft entries.
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
