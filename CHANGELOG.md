# Changelog

All notable changes to the `plus` edition are recorded here.
Upstream releases (`v1.0.0`, `v1.1.0`, …) are tagged upstream; only `plus-*`
tags are cut here. Dates are commit dates (`YYYY-MM-DD`).

## [Unreleased]

### Added

- Request log and a fifth **Logs** tab: every client call (`chat` or `responses`) produces one in-memory row with its outcome, timings, selected `provider:model` and key label, top-level field names, and a summary of each upstream attempt. Failed attempts share the row instead of adding noise. Rows are metadata only — prompts, answers, headers, and key values are never stored — and the last 500 live in memory only, cleared on restart. `GET /api/logs` (admin session, `no-store`) returns them newest first, and every gateway response carries `X-Free-Router-Request-Id` matching its row. The tab refreshes every 5 seconds only while visible, with a manual Refresh button.
- `/v1/models` entries now carry the full metadata the catalogs publish, not just `id`/`created`/`owned_by`/`context_length`: `max_output_tokens`, `name`, `description`, `supported_parameters`, `input_modalities`, `output_modalities`, `pricing`, `expiration_date`, `provider`, and `free`. Metadata is merged per model across providers, so a Google allowlisted model reports its `inputTokenLimit`/`outputTokenLimit` (previously hard-coded to `0`) and borrows `created` from whichever provider publishes a release date.
- A favicon (`/favicon.svg`, inline SVG served by the gateway, no external asset) plus pinned-tab and theme-colour declarations; it loads on the login screen, before any session exists. Three formats are served because each one has its own rules: the tab icon, a black-on-transparent `/mask-icon.svg` in a 16×16 viewBox for Safari pinned tabs (Safari paints only its alpha channel and ignores its colour), and a full-bleed 180×180 `/apple-touch-icon.png` generated in-process for the iOS home screen (Apple documents PNG only, and a transparent corner renders black).
- `POST /v1/responses`: the gateway now speaks the OpenAI Responses API on the same pool, keys, quota, cooldown, and usage counters as chat completions. Requests and answers are translated in both directions (`input`, `instructions`, `tools`, `text.format`, `reasoning.effort`, `max_output_tokens`), streaming emits the standard `response.*` event sequence, and custom tools round-trip as `custom_tool_call`. Stateful fields (`store`, `previous_response_id`, `conversation`, `background`, `prompt`, `item_reference`) are refused with a 400 instead of being ignored.
- Free-tier probing now runs for every price-free catalog by default (Gemini, TokenRouter, B.AI) and a new HashNeuron provider is shipped; a probe that returns a positive `usage.cost`/`credits` is treated as billed and kept out of automatic routing.
- Cached free verdicts are re-adopted into discovery after a state-file loss, without spending another probe.
- Context-window pre-filter: estimated input plus requested output skips a candidate only when its published `context_length` is clearly too small; unknown limits and inline media keep it.
- SWE-bench Verified prior (shipped `app/data/swe-bench.json`) ranks models with no config anchor, `baselineScores` entry, or evaluation score; `/health`, the web UI, and `models.sh` report the source as `scoreSource`.
- Provider presets for Groq, Cerebras, Mistral, and Hugging Face, plus a `probeFreeTier` switch in the create form and each provider's advanced settings; the toggle applies without a restart.
- Discovery **Run now** bypasses the interval and runs in the background.
- The Settings timezone field is now a searchable dropdown instead of a free-text box: type to filter the runtime's IANA list (searching ignores `/` and `_`, so "los angel" finds `America/Los_Angeles`), arrow keys move, Enter commits, and each row shows its current UTC offset. The list ships with the page so it always matches what the server accepts. `POST /api/settings` now canonicalises aliases (`Asia/Kolkata` → `Asia/Calcutta`) and returns 400 for an unknown zone rather than storing it.
- LAN access toggle in Settings replacing the host textbox: ON writes `0.0.0.0`, OFF writes `127.0.0.1`; reachable addresses (LAN IPs, loopback, hostname) listed with container-view note; warning when enabling with zero gateway keys. Turning it on also shows a red plaintext notice: the gateway has no TLS, so the admin password, gateway keys, prompts and answers cross the network in clear text — do not use it on a public IP; put an HTTPS reverse proxy in front instead.
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
- Implicit model pool replacing routes: adding a provider is enough for its free models to become callable. A catalog that publishes prices contributes its zero-priced chat models automatically, a price-free catalog is probed, and `freeModels` covers providers without a catalog. `free-best` remains as the alias and the default when `model` is omitted. Membership and labels come from `app/pool.mjs`, and unselected paid models answer `404 model_not_enabled` while unknown IDs answer `404 model_not_found`.
- Paid models are opt-in: selecting one under Providers → Models shows a warning, then lists it in `/v1/models` and uses it only when a request names it. A paid model never joins an automatic fallback or an exploration pick.
- Insufficient funds parks only the affected `provider:model` for 24 hours (`cooldownMs.insufficientFunds`), persisted in the state file. `402` always counts; `400`/`403` count only when the message mentions funds, credits, balance, or billing; `429` never does. A request naming a blocked model gets `402` with `error.type = "insufficient_funds"`, `retry_after_seconds`, and `Retry-After`, without contacting the upstream, and the block expires by itself.
- Background probe batches start as soon as a provider is added or a key is saved, without waiting or restarting. Results join the pool incrementally; the Providers tab polls while `probing` is true or `probePending` is above zero. `discovery.evaluation.probeBatchSize` (3), `probeBatchDelayMs` (2000), and `probeMaxPerProvider` (100) bound the work, and `evaluation.enabled: false` stops it.
- Per-provider model table under Providers → Models: membership, free/paid/unknown label, source, status (ready, cooling, payment-blocked until a time, no key), and a daily-limit input per model, plus the provider-wide `provider:*` default. Unchecking an entry actually removes it, instead of only merging selections in.

### Changed

- Chat Completions requests are rebuilt from the documented fields before they go upstream, so client bookkeeping (`features`, `variables`, `files`, `tool_ids`, `metadata`, `models`, ...) cannot trigger a strict provider's `400 Unknown name`. `stream_options` is forwarded only when the provider accepts it (`streamOptions: false` on the shipped Gemini entry).
- Chat streams are normalized instead of passed through: missing `id`/`created`/`object` are filled in, `model` is rewritten to the id the client requested, `reasoning` and `reasoning_content` stay in sync, exactly one `[DONE]` terminates a success, and an upstream that dies after the commit emits an SSE error frame plus `[DONE]` rather than ending silently.
- Each request logs its dialect and top-level field names (never content), so a failing client can be identified from the log alone.
- Latency ranking now measures time to the first useful token rather than the whole answer, and consecutive timeouts double that candidate/key's cooldown up to `cooldownMs.timeoutMax` (default 1h); any other outcome resets the streak.
- The SOCKS fallback now streams curl's output as it arrives instead of buffering the whole transfer, so SSE answers stay incremental when the proxy path is active.
- A silent upstream no longer holds a stream until the 180s attempt timeout. `firstByteTimeoutMs` (default 60s, `FREE_ROUTER_FIRST_BYTE_TIMEOUT_MS`, 0 disables) aborts an attempt that has produced no body byte by then — covering both the wait for response headers and the wait for the first chunk after them — and the next candidate answers. The commit grace runs on a timer now, so a single reasoning delta followed by a long silence still sends headers at the deadline, and a committed stream writes an SSE `: keep-alive` comment after `streamKeepAliveMs` (default 15s, `FREE_ROUTER_STREAM_KEEPALIVE_MS`, 0 disables) of upstream silence.
- The edit modal's **Fetch models** button now names the provider instead of sending only its base URL, so the listing runs with the keys already stored for that provider and its own auth header. HashNeuron answers `401` to an anonymous `/models`, which made the button fail on a provider whose key was saved and working; a pasted key is still tried first, a rejected one falls back to the stored keys, and a rejected credential now says so rather than reporting `catalog HTTP 401` alone.
- The web UI has four tabs (status, access, providers, settings). Routes and Quota are gone: daily limits and Discovery live on the Providers tab, and the Status tab shows the free and paid pool with a named-only note for paid entries.
- `/health` and `/api/state` report `pool` (`free`, `paid`, counts) and `paymentBlocks`; `/v1/models` lists the alias, the free pool, then selected paid models, using `provider:model` for a paid entry whose bare ID collides with a free listing. `POST /api/discovery` no longer takes a provider.
- `script/models.sh` follows the pool, defaults to the free list, and `--paid` adds the selected paid entries.
- Overlay schema v2 removes `routes`, `_removedRoutes`, `discovery.route`, and `discovery.provider`, and adds the three probe defaults plus `cooldownMs.insufficientFunds`. A custom route order is not migrated: zero-priced models return through catalog prices, and `freeModels` entries are kept.
- Structured layout: code in `app/`, ops in `script/`, tests in `test/`, packaging in `docker/`, single writable `data/` dir.
- `.env` files are a first-boot seed only; once an overlay exists they are ignored so UI edits always stick. Explicit process environment still wins.
- Runtime state (overlay, discovery, logs) lives under `data/`; legacy root files auto-move on boot; pid/log paths live in `data/`.
- Compose publishes `8787` on all interfaces and drops `env_file`/`environment`; settings come from `data/.env` (first boot) and the overlay.
- Login, gateway keys, provider keys, and UI copy kept from the LAN era.

### Fixed

- Tool calls on the Chat Completions path no longer reach clients in a shape they discard. Gemini's compatibility layer streams a finished call without `index` and closes with `finish_reason: "stop"`; OpenAI-compatible clients (Open WebUI among them) aggregate tool calls by `index` and only execute them on `finish_reason: "tool_calls"`, so the answer arrived as an empty message and the turn looked like a silent failure. The stream normalizer now assigns a stable slot per call (reusing it for later argument fragments, keeping any index the provider did send) and rewrites a `stop` that ends a tool-call turn to `tool_calls`. The Responses dialect already normalized both.

### Removed

- `config.routes`, route tombstones, and `POST /api/routes`; a route name is no longer a switch. `free-best` survives only as an alias.
- The Routes and Quota tabs, along with their editors, draft state, and dead i18n keys.
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
