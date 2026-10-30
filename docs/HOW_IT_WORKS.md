# How Free Router works

> English | [中文](zh-CN/HOW_IT_WORKS.md)

Technical reference. The short overview lives in the [README](../README.md).

## Requirements

- Node.js 20+
- An API key for at least one provider — in `.env`, or pasted in the web UI
(Providers tab), which stores it in the gitignored `config.local.json`

A missing key just drops that provider from ranking.

## Configure API keys

Provider keys live in `config.local.json` (gitignored, never committed) or in the environment. On first boot, keys found in `.env` are imported into `config.local.json` automatically. `config.json` holds defaults only and stays merge-clean; the server deep-merges both at startup (objects recurse, arrays and scalars come from the overlay when present). Copy the example file, uncomment the keys you have, and fill them in:

```bash
mkdir -p data && cp .env.example data/.env
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes, for OpenRouter fallbacks and model discovery | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | No | Your TokenRouter account |
| `BAI_API_KEY` | No | [chat.b.ai](https://chat.b.ai) API keys. One key covers all official B.AI models |
| `GEMINI_API_KEY` | No | [Google AI Studio](https://aistudio.google.com/apikey). Free-tier Flash-Lite is quota-limited, not unlimited |

Any later provider named `foo` reads `FOO_API_KEY` and `FOO_BASE_URL` unless you override `keyEnv` / `baseUrlEnv` in config.

Lookup order, first non-empty value wins:

1. Process environment (`export OPENROUTER_API_KEY=...`)
2. `.env` in the project directory
3. `~/.hermes/.env`, if you already keep keys there

`.env` is gitignored. Do not put keys in the systemd unit, README, or config.

Optional settings are listed in `.env.example`: listen address, upstream base URLs, and the OpenRouter app title/referer.

## Run

```bash
git clone https://github.com/sitaoo/free-router.git
cd free-router
mkdir -p data && cp .env.example data/.env
# edit data/.env and set the keys you have
./script/start.sh
```

The gateway listens on `127.0.0.1:8787` by default. Stop it with `./script/stop.sh`. Run these scripts as a normal user. If started as root, they re-exec as the directory owner and refuse to stay root.

If `ALL_PROXY` (or `HTTPS_PROXY`; `socks5`/`socks5h` only) names a SOCKS proxy, upstream calls go through curl. A direct request is tried first unless the host is listed in `socksFirstHosts`, and the fallback is only used when direct DNS fails. The bridge streams curl's output as it arrives, so an SSE answer reaches the client token by token instead of in one burst after the transfer ends.

## Run with Docker

```bash
git clone https://github.com/sitaoo/free-router.git
cd free-router
mkdir -p data && cp .env.example data/.env
# edit data/.env before the first boot. A published Docker port needs
# FREE_ROUTER_HOST=0.0.0.0, plus a non-default FREE_ROUTER_WEBUI_PASSWORD
# and a FREE_ROUTER_API_KEY: a wide bind refuses to start without them.
docker compose -f docker/compose.yaml up -d
```

The published port only reaches a server listening on `0.0.0.0`, so that seed is required; a fresh container left on the default `127.0.0.1` is unreachable even from the host. Because that binding also accepts LAN connections, the server refuses to start while the admin password is still `admin123` or no gateway key exists — the password and key in the seed satisfy the check. Open `http://127.0.0.1:8787/` with the seeded password; clients use the seeded gateway key. To keep the published port local-only, map `127.0.0.1:8787:8787` instead of `8787:8787`. On first boot the `.env` seed is migrated into `data/config.local.json` and `.env` files are ignored afterwards, so later UI edits always stick. Keys are never baked into the image. Discovery state lives in `data/` and persists across rebuilds via the mounted volume.

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs -f
docker compose -f docker/compose.yaml down
```

To pick up code changes, rebuild and recreate:

```bash
docker compose -f docker/compose.yaml up -d --build
```

Foreground:

```bash
node app/server.mjs
```

List the current model pool (free models first, same order the gateway will try them; `--paid` also lists the selected paid models):

```bash
./script/models.sh
./script/models.sh --paid
./script/models.sh --ready-only
npm run models -- --json
```

See where requests actually landed, and how much of today's quota is left:

```bash
./script/models.sh --usage
```

## Web interface

Open <http://127.0.0.1:8787/> and log in (default password `admin123`, change it in Settings → Admin). The interface has five tabs: status, access keys, providers, settings, and logs. The Status tab shows the live pool priority; the Providers tab holds keys, each provider's model table (free/paid membership and daily limits), and Discovery; the Logs tab shows the last 500 client requests as a table (time, dialect, requested model, answered `provider:model [key]`, result pill with finish reason, tool calls, and character counts, duration and first token in seconds with one decimal, input and output tokens and output speed in tokens per second with the interface language's thousands separators, and each upstream attempt), refreshing every five seconds while it is open. Its top row is a set of ghost buttons: **Refresh**, **Copy all**, **Export JSONL**, **Export text**, and **Clear**. Copy and both exports write the same three lines per request as the container log (timestamp and request id, dialect, outcome and status, timing, first token, field names; then the requested and answered model with finish reason, tool calls, text/reasoning character counts, input/output tokens, and speed; then every upstream attempt), so a failing request can be pasted into a bug report unchanged. Copy falls back to a textarea when the page is served over plain HTTP, where the clipboard API is unavailable; Clear empties the in-memory list after a confirmation. Rows are metadata only — prompts, answers, headers, and key values are never stored — and live in memory, so they are cleared on restart; every gateway response carries `X-Free-Router-Request-Id` matching its row. It follows the browser language and applies every change to the running process immediately — except host, port, and a few marked settings, which need a restart (there is a Restart button next to Save; under Docker the supervisor brings the server back up). The theme button in the top bar cycles follow-system, light, and dark; the choice is stored in that browser's local storage.

```json
"webui": {
  "enabled": true,
  "envFile": ".env"
}
```

Set `enabled: false` to remove `/` and `/api/*` entirely.

### Authentication model

There are two independent gates:

- **Web UI + management APIs** (`/`, `/api/*`): admin password login issuing
an `HttpOnly` session cookie. Sessions expire after `webui.sessionTtlHours` (default 24, `0` means never, browser-session cookie in that case). Changing the password revokes all sessions.
- **Gateway API** (`/v1/*`): bearer keys once at least one exists (Access
tab). Without any gateway key, `/v1` stays open for local use.

On top of authentication, browser-driven abuse is still filtered: cross-site requests per `Sec-Fetch-Site` are rejected, and a `Host` header pointing at a public domain (DNS rebinding) is rejected while loopback, LAN, and `.local` names are accepted. A plain `curl` call sends neither header and still works.

The page ships a `Content-Security-Policy` of `default-src 'none'` with inline script and style allowed, `connect-src 'self'`, and `img-src 'self'`. The image rule is load-bearing rather than decorative: the tab icon is an image the page itself declares, and without an explicit `img-src` the fallback to `default-src 'none'` blocks it before the request is even made, so the tab silently shows nothing. Three icon formats are served because each one is specified differently — `/favicon.svg` for the tab, `/mask-icon.svg` for Safari pinned tabs (Safari uses only the alpha channel and paints it with the `color` attribute, so it has to be one black shape on transparency in a 16×16 viewBox), and `/apple-touch-icon.png` for the iOS home screen (Apple documents PNG only, and iOS applies its own rounded mask, so the icon is full-bleed). The PNG is generated in-process at boot rather than checked in, which keeps the repository binary-free. See `app/icons.mjs`.

### Why the key endpoints need care

Since `script/start.sh` sources the env file with `set -a`, being able to write an arbitrary variable there would mean code execution on the next start. The write path is therefore constrained:

- Provider keys are addressed **by provider name**, never by raw variable
name. The server resolves `keyEnv` from the merged config, so nothing outside a configured provider's key variable can ever be written.
- Values containing a newline or NUL are rejected, so one field cannot append
a second assignment.
- The env file is written atomically with mode `0600`, and an existing file is
chmod'ed down to match.
- Keys are returned masked, never in full (a new gateway key is shown once,
at creation).
- The secret redactor is rebuilt after a key change, so a key added through the
UI is still stripped from upstream payloads.

## LAN access

1. Bind wider: `FREE_ROUTER_HOST=0.0.0.0` and publish the port
(`8787:8787` in `docker/compose.yaml`, plus any host firewall rule).
2. In the web UI, create a gateway API key (Access tab) and change the admin
password (Settings tab). The status tab links directly to both until done.
3. Call `/v1/*` with `Authorization: Bearer <key>`; open the UI from any LAN
browser and log in.

The gateway itself speaks HTTP only, with no TLS: once the bind is widened, everything crossing that port — the admin password, gateway keys, prompts, model replies — travels in clear text and anyone on the same network segment can read it off the wire. Do not expose it this way when the machine has a public IP. For remote access, put an HTTPS reverse proxy (Caddy, nginx) in front so the proxy terminates TLS, and keep `FREE_ROUTER_HOST` on `127.0.0.1` so only the proxy can connect. Turning the "Allow LAN access" switch on in the Settings tab shows a matching red warning on the server card.

The admin password is stored as a salted scrypt hash, never plaintext. `FREE_ROUTER_WEBUI_PASSWORD` overrides it for emergency recovery.

## Gateway API keys

Named client credentials (`sk-fr-…`, shown once at creation) for anything calling `/v1/*`. Creating the first key enables auth; deleting the last one disables it again (or flip the switch in the Access title row — it refuses to enable with zero keys). Keys are checked on `/v1/models`, `/v1/chat/completions`, and `/v1/responses`; `/health` stays open for container probes.

## Provider keys (multi-account)

Each provider can hold any number of keys. Named keys live in `config.local.json` (UI-managed, with remarks); environment keys come from `<KEYENV>`, `<KEYENV>S`, or `<KEYENV>_KEYS` (comma-separated, auto-named, read-only in the UI). Effective order per request: file keys, then the single variable, then the plurals, deduplicated by value. Requests rotate across them; a `401` retires only that key, rate limits and timeouts cool down only that key, and the next key is tried before moving to the next model.

On first boot, keys found in `.env` are imported into `config.local.json` once (named `migrated-N`) and removed from `.env`, with a dismissible notice in the UI. Once an overlay exists, `.env` files are ignored entirely (explicit process environment still wins). A personal `FREE_ROUTER_API_KEY` in `.env` additionally becomes a named gateway key (`script/models.sh` prefers the environment variable, then the overlay gateway key, so it keeps working with no `.env` at all).

## Layered configuration

`app/config/config.json` holds defaults and stays merge-clean (byte-identical to upstream where possible). Everything the operator changes — via the web UI or the first-boot `.env` seed — is written to the gitignored `data/config.local.json`, which the server deep-merges over defaults at startup (objects merge per key, arrays and scalars are replaced). The base file is never written at runtime. All operator state (overlay, discovery state, `.env` seed, logs) lives under `data/`; a boot-time upgrade moves legacy root files (`config.local.json`, `discovered-free-models.json`, `.env`) there automatically, and logs live in `data/logs/`.

Consequences worth knowing:

- `git pull` can never conflict with your settings, and your settings can
never leak into a commit.
- Provider deletions are recorded as tombstones, so a base entry you deleted
stays deleted after upgrades. Route tombstones from older versions are dropped
by the schema migration.
- Structural additions ship as additive-only schema migrations (new skeleton
keys, never touching your values), stamped with `_schemaVersion`.
- Full precedence, highest first: explicit process environment →
`data/config.local.json` (UI writes and first-boot seeds) → `.env` files (first boot only; ignored once an overlay exists) → `app/config/config.json` → code defaults. `FREE_ROUTER_CONFIG` swaps the base file, `FREE_ROUTER_DATA_DIR` swaps the data dir; tests point both at a temp dir so they stay isolated.

## Use with any OpenAI-compatible client

Point the client at the gateway and, when gateway auth is on, send any of your gateway keys as the bearer token (with auth off, any placeholder like `local` works). Upstream provider keys stay on the gateway. Keep a localhost-only bind if you never enabled auth.

**curl**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{
    "model": "free-best",
    "messages": [{"role": "user", "content": "Reply with exactly: router-ok"}]
  }'
```

**OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

**Hermes**

```yaml
model:
  default: free-best
  provider: custom
  base_url: http://127.0.0.1:8787/v1
custom_providers:
  - name: free-router
    base_url: http://127.0.0.1:8787/v1
    api_key: local
    api_mode: chat_completions
    discover_models: true
    models:
      - free-best
```

Or add a `model_aliases.free-best` entry and switch with `/model free-best`.

The selected upstream is returned in `X-Free-Router-Provider` and `X-Free-Router-Model`, plus the provider's normal `model` field.

Both dialects are hardened in transit. On the way out, the upstream request is rebuilt from the documented Chat Completions fields, so client bookkeeping such as `features`, `variables`, `files`, `tool_ids`, `metadata`, and `models` never reaches a provider that would answer `400 Unknown name "features"` (Gemini's compatibility layer does). `stream_options` is sent only when the provider accepts it: set `"streamOptions": false` on a provider that rejects it. When it is sent, the gateway always asks for `include_usage`, because the request log reports input/output tokens and output speed; a client that did not ask for usage gets neither the usage-only chunk nor the numbers inside ordinary chunks, so the wire still looks exactly like what it requested. On the way back, stream chunks are normalized rather than passed through: `id`, `created`, and `object` are filled in, `model` is the id the client requested (not the provider's), `reasoning` and `reasoning_content` are kept in sync, and exactly one `[DONE]` ends a successful stream. Streamed tool calls are made index-addressed, and a turn that contained tool calls ends with `finish_reason: "tool_calls"` even when the provider reported `stop` (Gemini's compatibility layer does both): OpenAI-compatible clients aggregate calls by `index` and only run them on that finish reason, so an unrepaired stream shows up as an empty answer. A provider that dies after the response was committed produces an SSE error frame plus `[DONE]` instead of ending silently. Every request also logs its dialect and top-level field names (never their content).

## Responses API

`POST /v1/responses` is served out of the box, on the same pool, key rotation, quota, cooldown, and usage counters as `/v1/chat/completions`. Almost every provider behind the gateway speaks only Chat Completions, so the gateway translates in both directions instead of proxying: `input`, `instructions`, `tools`, `tool_choice`, `max_output_tokens`, `text.format`, and `reasoning.effort` become a chat request, and the chat answer (or its SSE deltas) becomes a `response` object (or the `response.*` event stream).

```bash
curl -s http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{"model": "free-best", "input": "Reply with exactly: router-ok"}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.responses.create(model="free-best", input="Hello").output_text)
```

What the translation keeps: `instructions` (as the system message), string and item-array `input`, `input_image`, `function_call`/`function_call_output` history, function tools, `text.format` (as `response_format`), reasoning effort, and streaming. Custom (free-form) tools are offered upstream as a function taking one string and returned as `custom_tool_call`, so Codex-style clients keep their raw tool input.

What it refuses with `400 invalid_request_error`, because a stateless fan-out cannot honour it: `store: true`, `previous_response_id`, `conversation`, `background: true`, `prompt` templates, and `item_reference` items. Hosted tools (`web_search`, `file_search`, …) need provider-side execution, so they are dropped rather than forwarded.

Streams emit the standard sequence (`response.created` → `output_item.added` → `content_part.added` → `output_text.delta` … → `response.completed`, or `response.incomplete`/`response.failed`) with contiguous `sequence_number`s, then a final `data: [DONE]` for OpenAI SDKs that wait on it.


## Endpoints

```text
GET  /                       web interface (login required)
POST /api/login              { "password": "..." } -> session cookie
POST /api/logout             revoke current session
GET  /api/state              full UI state (session required)
GET  /api/logs               last client requests, newest first (session required)
DELETE /api/logs             clear the in-memory request list (session required)
POST /api/keys               provider keys: { "provider", "name"?, "key" }
POST /api/gateway-keys       gateway keys: { "action": "create|delete|setRequireAuth", ... }
POST /api/providers          { "action": "create|update|delete", ... }
POST /api/limits             daily limits: { "action": "set|delete", "key", "limit" }
POST /api/discovery          discovery toggles, interval, pins
POST /api/settings           tuning knobs, session TTL, migration notice
POST /api/webui-password     { "password": "..." } (stored hashed, revokes sessions)
POST /api/server             { "host", "port" } (restart to apply)
POST /api/restart            exit for supervisor restart (session required)
GET  /health
GET  /v1/models              gateway key required once auth is on
POST /v1/chat/completions    gateway key required once auth is on
POST /v1/responses           same pool, keys, limits, translated Responses dialect
```

`GET /health` reports `version` from `package.json` (currently `1.0.0`). Releases are git tags of the form `v1.0.0`.

`GET /v1/models` returns the `free-best` alias, every free text-chat model in the pool, then the explicitly selected paid models. Free models are listed by bare ID (deduplicated across providers); when a selected paid model would collide with a free listing of the same ID, it appears as `provider:model` instead. Naming a free model tries every provider that currently offers that same slug; naming a paid model uses exactly the selected `provider:model`.

Each entry carries the four standard OpenAI fields (`id`, `object`, `created`, `owned_by`) plus what the catalogs actually publish about that model: `context_length`, `max_output_tokens`, `name`, `description`, `supported_parameters`, `input_modalities`, `output_modalities`, `pricing`, `expiration_date`, `provider`, and `free`. Metadata is merged per model across providers, because the dialects disagree on what they report — Google's native listing gives `inputTokenLimit`/`outputTokenLimit` but has no release date, while OpenRouter supplies `created` and `top_provider.max_completion_tokens`. A field one provider omits is filled from another provider offering the same model; pricing is never borrowed, since a price is per provider. Anything genuinely unknown stays `0` (or is omitted) rather than invented.

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Model pool

There is one implicit pool and no route list to maintain. A provider contributes two kinds of members:

- **Free models the rules can prove.** On a catalog that publishes prices, every chat model with `pricing.prompt = pricing.completion = 0` joins automatically. On a provider without prices, `freeModels` is the allowlist. A positive probe verdict also admits a model. A negative verdict (billed, rate-limited with no free allowance, permanently refused, or refused for this account for lack of a balance/deposit) keeps it out.
- **Models the operator explicitly selected** in Providers → Models. A selection is membership, not proof of freeness: the model is labelled free, paid, or unknown-price from the evidence, and a paid/unknown selection warns before it is added.

`free-best` remains as the alias for "the free pool, best first" and is the default when a request omits `model`. A paid model is never part of an automatic fallback: it is used only when the request names it, either by bare ID (when free models of the same ID come first) or by `provider:model`. A known-but-unselected model answers `404 model_not_enabled`; an unknown ID answers `404 model_not_found`.

Membership follows the catalog: a free model that disappears or turns paid leaves the pool at the next catalog check. A selected model stays selected even when a probe calls it paid; the negative verdict only affects whether it is labelled free. Models without a usable key are shown in the UI but cannot be routed. IDs that differ only by org prefix or a `:free` suffix (for example `gemini-3.8-flash` and `google/gemini-3.8-flash:free`) count as the same model for request matching.

### Paid models and insufficient funds

Selecting a paid model in Providers → Models shows the warning "Paid models may cost you money. Add them with care." (Chinese: 付费模型可能会消耗你的费用，请谨慎添加). The model then appears in `/v1/models` and in the Status tab's separate paid list, marked as named-only.

If a paid call is refused for insufficient funds, only that `provider:model` is parked for `cooldownMs.insufficientFunds` (default 24 hours); the provider, its keys, and free models are untouched. The refusal is recognised as `402` always, or `400`/`403` whose message mentions funds, credits, balance, or billing; `429` is never treated as insufficient funds. Inside the window a request naming that model receives `402` with `error.type = "insufficient_funds"`, `retry_after_seconds`, and a `Retry-After` header, without contacting the upstream. The block is persisted in the state file, so a restart does not forget it, and it expires by itself; there is no timer to clear.

## Add a provider

No code change is needed for an OpenAI-compatible `/chat/completions` endpoint. The registry in `providers.mjs` loads every block under `config.json` `providers`. Easiest is the web UI (Providers tab → Add provider): the preset menu fills the base URL and discovery flags for Gemini, OpenRouter, TokenRouter, B.AI, HashNeuron, Groq, Cerebras, Mistral, and Hugging Face, and Custom accepts anything else. A preset is only a shortcut — you still paste the key yourself. To do it by hand:

1. Add a provider object. Set `"catalog": true` if it exposes `GET /models`.
Set `"pricing": true` only when that response carries per-token prices; the
server re-checks the fetched rows, so a catalog that turns out to publish no
prices falls back to probing.
2. Nothing else is needed to join the pool. A priced catalog contributes its
zero-priced chat models automatically; a price-free catalog is probed in the
background once a key is present. On a provider with no catalog, list the free
IDs under `freeModels` (see below).
3. To enable a paid or unknown-price model, add it to that provider's
`selectedModels` (Providers → Models does this, with a warning).
4. Optionally pin `name:model` in `discovery.evaluation.pinnedModels`.
5. Set `<NAME>_API_KEY` in `.env` or `~/.hermes/.env`, or paste the key in the
web UI. Override the URL with `<NAME>_BASE_URL` if needed.
6. Restart only if you changed flags that require it (`catalog`, `pricing`);
keys, URLs, allowlists, selections, and `probeFreeTier` apply immediately.

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

Optional fields: `keyEnv`, `baseUrlEnv`, `headers`, `chatPath`, `modelsPath`, `discover: false` to keep a priced catalog provider out of discovery, `probeFreeTier: true` to let a price-free catalog contribute models by probing, and `streamOptions: false` for a provider whose OpenAI-compatible layer rejects `stream_options`. The create form and each provider's advanced settings expose the same probe switch; toggling it there takes effect without a restart.

Two fields cover a catalog served outside the chat prefix, on its own auth: `modelsUrl` for an absolute listing URL and `modelsKeyHeader` for the header carrying the key. Gemini needs both, because its native listing is the only place `supportedGenerationMethods` appears and it answers `401` to a Bearer token. Either response shape is accepted: OpenAI's `data[].id` or Google's `models[].name`.

### What each provider contributes to discovery

`catalog` and `pricing` are separate switches, because fetching `/models` and being able to tell free from paid are separate capabilities.

| `kind` | Config | Free models come from | Discovery role |
|---|---|---|---|
| `catalog` | `catalog: true, pricing: true` | zero-priced catalog entries | adds and removes models |
| `static+catalog` | `catalog: true, pricing: false` | `freeModels`, plus anything the provider serves for free | removals, and additions when `probeFreeTier` is on |
| `static` | neither | `freeModels` | none |

A catalog that publishes per-token prices can add unknown models from the listing alone. Gemini's, TokenRouter's, B.AI's and HashNeuron's `/models` carry no `pricing` field and mix free and paid models, so auto-adding from the listing could send traffic to a billed model. They are probed instead (`probeFreeTier`, below), which is on by default for all four. Their catalogs are also fetched to drop a `freeModels` entry that has disappeared upstream and to supply probe candidates. A withdrawn model returns automatically once the provider lists it again.

Adding or updating a provider, or saving a key, starts a background probe batch without waiting for it and without a restart. Results join the pool as each batch finishes; the Providers tab refreshes while `probing` is true or `probePending` is above zero. `discovery.evaluation.probeBatchSize` (default 3) sets models per batch, `probeBatchDelayMs` (default 2000) spaces the batches, and `probeMaxPerProvider` (default 100) caps how many models one provider is probed for in a run. Turning `evaluation.enabled` off stops probing entirely.

A catalog that fails to load, returns nothing, or belongs to a provider with no key changes nothing: the previous pricing semantics and `freeModels` stay in effect. Removal requires a catalog that actually loaded, so an upstream outage cannot empty the pool.

The edit modal's **Fetch models** button names the provider (`{ "action": "fetch-models", "provider": "name" }`) instead of sending only a base URL. The server then lists `/models` with the keys already stored for that provider and its own auth header (`modelsKeyHeader`), so a listing that requires credentials — HashNeuron's answers `401` to an anonymous request — does not force the operator to paste a key that is already saved. A key typed into the form is tried first; a `401`/`403` on it falls back to the stored keys rather than failing the listing. An explicit `baseUrl` still overrides the saved one, so an edited URL can be tried before it is saved. When the failure is a rejected credential, the error says so instead of only `catalog HTTP 401`.

Model IDs are matched by slug, so Gemini listing `models/gemini-3.8-flash` against a configured `gemini-3.8-flash` is not read as a withdrawal.

`/health` reports this under `discovery.addsFrom`, `discovery.availabilityOnly`, and `discovery.unavailableModels`; the web UI shows withdrawn models next to the owning provider.

## Free-model discovery

The router checks each priced catalog and each `probeFreeTier` catalog every `discovery.intervalMs` (currently every 2 days) for newly free text-generation models. **Run now**, in Providers → Discovery, bypasses that interval and starts a run in the background, so an operator does not have to wait for the timer or restart the server. Each new model receives one cached hybrid evaluation using deterministic reasoning/instruction checks, response latency, context size, and tool/structured output support. Its score places it among the pool's seed anchors.

Scores are made of three parts, capped so no single part can dominate:

| Part | Max | Notes |
|---|---|---|
| benchmark | 65 | 10 deterministic items; the 3 hardest carry 28 points |
| metadata | 20 | tools, structured output, context length, modality, recency |
| latency | 6 | one cold sample, so deliberately a small tiebreaker |

A model is re-evaluated when its stored score is missing, still `pending`, or was produced by an older benchmark version. Without this, a model whose single evaluation attempt hit a 429 would keep the fallback score of `-1` and stay last forever, because it was already tracked and so never looked like a new discovery again. At most `evaluation.maxPerRun` models are evaluated per run. When there is no configured anchor, no `baselineScores` entry and no evaluation score, the router falls back to a shipped SWE-bench Verified prior (`app/data/swe-bench.json`, the same unofficial snapshot upstream publishes) instead of `-1`. `/health` reports which source won per entry as `scoreSource`: `baseline`, `evaluation`, `swe-bench`, or `unranked`; the Status tab's pool table shows it as a tooltip on the score cell.

Ranking also reacts to real traffic. Once a model has at least `evaluation.usageMinRequests` recorded attempts in the usage window, its success rate shifts its score by up to `evaluation.usageWeight` points: 100% success adds the full weight, 80% is neutral, 60% or worse subtracts the full weight. Pinned models are exempt. When one model is offered by several providers, the group is ranked by its best provider, so one bad provider does not sink the model. `./script/models.sh` shows the score, its source, and the current shift in the `score`, `source`, and `rank+-` columns, and `/health` reports `baseScore` and `scoreAdjustment` per entry.

### Scoring scale and live signals

All base signals live on a documented 0-100 scale: config anchors (94 down to a 30 floor, plus a capped capability-portrait bonus so a strong model placed low is not stuck), evaluations (~0-91), hand-written `baselineScores` (clamped into range), and usage adjustments (±`usageWeight`). Pinned models sit above the scale at a finite 150 and skip traffic adjustments.

Failures are classified before they touch scores: capacity signals (`rateLimit`, `timeout`, `overloaded`) drive cooldowns only; routing, billing and credential faults (`notFound`, `forbidden`, `payment`, bad-key `401`s) are recorded but never scored. Only quality failures (empty or broken responses, upstream errors) move the score. Consecutive timeouts double the cooldown of that candidate/key (`cooldownMs.timeout` is the first wait, `cooldownMs.timeoutMax` the cap, default one hour), and any other outcome resets the streak: a model that keeps hanging is not retried on the same five-minute cadence as one that failed once.

Two live signals refine the order on every request:

- **Scarcity**: within 5 points, higher remaining daily quota wins, so
scarce-but-smart models are saved for when they matter. Unlimited models sort first.
- **Latency**: rolling mean time to the first useful token adds +2 under 5s, 0
up to 30s, −2 above, once 5 samples exist. Measured to the first content or
tool-call delta, not to the end of the answer, so a long answer is not a slow
start. Small and capped by design.

A few percent of requests (`routing.explorePercent`, default 5) detour to an underexplored model so cold models can earn traffic; pinned models never give up first place. External leaderboards feed in through `script/sync-scores.mjs`, which writes `baselineScores` (40-80 prior band) plus provenance — see `./script/sync-scores.mjs --help`.

Before ranking, `filterCandidates` drops a model whose published `context_length` clearly cannot hold the request. It estimates input tokens from the message and tool JSON (CJK runs close to 1 token per character, Latin about 4 characters per token) and adds the requested `max_tokens` / `max_completion_tokens` / `max_output_tokens`, then skips the candidate only when the known window is smaller than that sum. An unknown window, an unknown size, or a request with inline media (billed by resolution, not characters) keeps the candidate, so the estimate can cost an extra upstream attempt but never rejects one that might have worked. Skipped candidates are logged with `request exceeds context window`.

### Asking a provider what is free

A provider without prices in its catalog can still answer the question, just not in the listing. With `probeFreeTier: true`, each unknown chat model gets one real request and the reply is read as the answer:

| Reply | Meaning | Effect |
|---|---|---|
| `200`, no billing fields | served on this key | free; enters the pool with its evaluation score |
| `200`, positive `usage.cost` / `credits` | served, but billed | not free; stays out of automatic routing |
| `429`, every free-tier `limit: 0` | no free allowance exists | not free |
| `429`, some `limit` above `0` | free, but spent for now | kept; the number becomes its daily limit |
| `404` | not served, or withdrawn | not free |
| `400` "only supports Interactions API" | not a chat model | dropped from the candidate list |
| `402`/`400` insufficient balance, `403` deposit required | served, but this account must pay | not free; leaves the pool like a withdrawal |
| timeout, `5xx` | says nothing | no verdict; retried next run |

A positive bill on the response outranks the catalog and the status code: the request ran, but it was not free, so the model stays out of automatic routing. A selected paid model is unaffected by a negative verdict; only its free label changes. A key with no billing attached is still preferable, because a gateway that bills without reporting `cost` cannot be detected this way.

Each verdict is cached in the state file, so a model costs one probe ever rather than one per run, and `evaluation.maxPerRun` caps a single run. A "not free" verdict expires after `discovery.verdictRetryMs` (defaulting to the discovery interval) so a provider blip cannot retire a model permanently; a "free" verdict does not expire, because ordinary traffic revisits it and a later refusal replaces it.

Free verdicts survive the discovered-entry list. If a state migration or hand edit keeps the verdict but drops the entry, the next catalog refresh adopts the model back into the pool without spending another probe.

Verdicts outrank `freeModels` in both directions. That is the point: an allowlist in `config.json` is a guess about someone else's pricing, while a quota figure is that provider stating its own terms.

The candidate list is narrowed before anything is sent. Google's native listing marks capability in `supportedGenerationMethods`, so embedding, video, and live audio models are dropped without naming them. Image, speech, music, transcription, and agent-only models share the `generateContent` method with ordinary chat models, so `discovery.exclude.modelPatterns` carries those, along with `-latest` aliases that would double-count one allowance with the concrete model they resolve to.

### Daily limits the provider reported

`usage.dailyLimits` in `config.json` is a starting guess. When a provider refuses a request and states the real allowance, that number replaces the configured one for that model. `/health` marks which is in use: `reported` came from the provider, `configured` is still the local guess.

The same reply drives the cooldown. A spent daily quota waits until the quota day rolls over in `usage.timezone` rather than a fixed interval, so the router neither retries all night for nothing nor idles past the reset. A per-minute limit uses the `retryDelay` the provider asked for.

### Excluding domain-specific models

A narrow, domain-tuned model aces a generic benchmark and then lands high in the ranking even though it is a bad default for general traffic. `discovery.exclude` keeps those out:

- `modelPatterns`: case-insensitive regexes matched against the model ID.
- `textPatterns`: case-insensitive regexes matched against the catalog `name`
and `description`. This is the more durable check, because a vendor's naming suffix changes but the description keeps saying what the model is for.

Two boundaries are deliberate. A model listed in `freeModels` or `selectedModels` is exempt, so an explicit entry always beats the filter. And exclusion only applies to automatically discovered free models: it never removes a selection from `GET /v1/models`, and a model named by its exact ID is a deliberate choice.

Filtering applies both when building the pool and during collection, so a new pattern takes effect on restart instead of after the next collection. `/health` lists the current matches under `discovery.excludedModels`.

`evaluation.baselineScores` overrides a score outright (clamped to 0-100), keyed by `provider:model` or by the bare model ID. It applies to discovered models as well as configured ones, and takes precedence over the evaluation score, so it is the way to bury a model whose automatic score you do not trust.

If an automatically discovered catalog model becomes paid, disappears, or stops qualifying as a text chat model, the next catalog check removes it from the pool automatically. It becomes active again only if a later catalog lists it as free.

Candidates from a `static` provider stay in the pool as long as they are listed under `freeModels` and a key is set. On a `static+catalog` provider they must additionally still appear in the fetched catalog; those that do not are reported under `discovery.unavailableModels`. A model in `selectedModels` stays in the pool regardless of the catalog, subject to having a usable key.

Discovery and evaluation state is stored in `discovered-free-models.json` and survives service restarts. That file is gitignored.

Configure the schedule and probing in `config.json`:

```json
"discovery": {
  "enabled": true,
  "intervalMs": 172800000,
  "stateFile": "discovered-free-models.json",
  "exclude": {
    "modelPatterns": [],
    "textPatterns": [
      "\\b(finance|medicine|legal)[\\s-]*(focused|specific)\\b"
    ]
  },
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "maxPerRun": 8,
    "usageWeight": 12,
    "usageMinRequests": 20,
    "probeBatchSize": 3,
    "probeBatchDelayMs": 2000,
    "probeMaxPerProvider": 100,
    "pinnedModels": [
      "gemini:gemini-3.5-flash-lite",
      "tokenrouter:z-ai/glm-5.3-free",
      "bai:glm-5.3-flash"
    ]
  }
}
```

`/health` reports the last collection time, free models seen, scores, the free and paid pool, and models removed because they are no longer free. The order of `freeModels` and `selectedModels` on each provider acts as the seed score anchor, decreasing by 4 per position from 94 down to a floor of 30; pinned, baseline, evaluation, and SWE-bench scores sit above it.

Evaluation requests are counted in the usage statistics like any other request, because they consume the same provider quota.

## Request history and daily quota

Every upstream attempt is counted per day and per `provider:model`, so you can see which models actually served this week's traffic and how close a provider is to its free daily cap. Counters live in the same `discovered-free-models.json` state file, are written back at most once every 1.5 seconds, and are pruned to `usage.retentionDays`.

```bash
./script/models.sh            # priority list with today / 7d / fail columns
./script/models.sh --usage    # per-day and per-model history
```

```json
"usage": {
  "retentionDays": 7,
  "timezone": "America/Los_Angeles",
  "dailyLimits": {
    "gemini:gemini-3.8-flash": 20,
    "gemini:gemini-3.5-flash-lite": 200
  }
}
```

- `timezone` decides when the day rolls over. Gemini free-tier request-per-day
counters reset at midnight Pacific, so keep it at `America/Los_Angeles` even if the host runs elsewhere. Omit the field to use the host's local date. In the web UI it is a searchable dropdown — the input is the filter — fed from the runtime's own IANA list plus `UTC`, so the picker can never offer a zone the server would reject. Saving canonicalises aliases (`Asia/Kolkata` is stored as `Asia/Calcutta`, case does not matter) and refuses an unknown zone with a 400 instead of writing it to the config, where a typo would otherwise only show up in the log after a restart and leave the day boundary quietly wrong. A change needs a restart, which the save note says.
- `dailyLimits` keys are matched as `provider:model`, then bare `model`, then
`provider:*`. Limits are informational only; the router does not stop sending once a limit is reached, because the numbers are hand-maintained.
- The `today` column and `remainingToday` count only quota-consuming attempts.
Rate limits, 404s, and 403s are excluded because the provider rejected them before running the model.
- Failure buckets are `rateLimit`, `timeout`, `serverError`, `empty`,
`notFound`, `forbidden`, `aborted`, and `other`, which is what makes it visible *why* a request fell through to a lower-priority model.

`GET /health` exposes the same data under `usage`, and each pool entry carries its own `usage` block.

## systemd user service

The unit assumes the repo lives at `~/free-router`. If you cloned somewhere else, edit `WorkingDirectory` and `ExecStart` before enabling it.

```bash
mkdir -p ~/.config/systemd/user
cp script/free-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router
journalctl --user -u free-router -f
```

`./script/start.sh` also works without systemd.

## Routing behavior

1. Ranks the **free pool**. Pinned models stay first, in config order; the
rest follow baseline rank, discovery scores, and provider seed order.
2. Uses the paid pool only when the request names a selected paid model. Paid
models never join an automatic fallback or the exploration pick.
3. At each model, tries every provider that currently offers it as a free
text-chat model. The provider whose `freeModels`/`selectedModels` lists it comes first; other listings for the same slug follow. Catalog IDs are matched after stripping an org prefix and a trailing `:free`, so a later free OpenRouter copy of a Google or B.AI model is tried immediately after the original instead of as a separate rank.
4. Skips a provider when none of its API keys is usable.
5. Refreshes catalog providers every 15 minutes.
6. Collects newly free catalog text models every `discovery.intervalMs`, evaluates them, and lets their score place them in the pool. A catalog listing of a model that is already known is attached to that model instead of being evaluated as a new one.
7. Removes automatically discovered catalog models that are no longer free, available, or text-chat compatible.
8. Removes models missing capabilities required by the request, such as tools
or image input.
9. Tries remaining candidates in that unified order, then applies the
all-cooling retry only for capacity failures; `payment`, `notFound`, and
`forbidden` never qualify, and blocked payment entries are never retried.
9. Applies per-provider/model/key cooldowns after rate limits, timeouts, server failures, and empty
successful responses. A `401` retires only that key; other keys keep serving.
10. Before sending a request upstream, redacts values of `*_API_KEY` / `*_TOKEN` /
`*_SECRET` / `*_PASSWORD` from the local environment (including provider keys, gateway keys, and the admin password), and `NAME=...` assignment lines for those names. This cannot stop Hermes from reading `.env` locally; it only keeps those values out of OpenRouter, TokenRouter, and B.AI payloads.
11. Buffers reasoning-only stream chunks. Nothing is sent to the client until a model emits content or a tool call, so an empty model can still be replaced. The wait is bounded by `streamCommitGraceMs` (default 10s, `FREE_ROUTER_STREAM_COMMIT_GRACE_MS` wins): once it expires the buffered prefix is flushed and the rest streams through live, so browsers and proxies never sit on a headerless connection. The deadline is a timer, so one delta followed by a long silence still commits on time instead of waiting for the next upstream read. A stream that commits this way but never yields content keeps its 200 yet counts as `empty`, never `ok`. A model that has produced no body byte at all by `firstByteTimeoutMs` (default 30s, `FREE_ROUTER_FIRST_BYTE_TIMEOUT_MS` wins, 0 disables) is treated as stuck rather than slow: the attempt is aborted and the next candidate answers, and the deadline covers both the wait for response headers and the wait for the first chunk after them. 30s is deliberately below the patience of ordinary clients (browsers and Open WebUI give up around 50s): otherwise a stuck first candidate — typically a pinned model that has just come off cooldown — burns the whole request and the client shows an error instead of the next model's answer. Once committed, an SSE `: keep-alive` comment is written whenever `streamKeepAliveMs` (default 15s, `FREE_ROUTER_STREAM_KEEPALIVE_MS` wins, 0 disables) passes without an upstream chunk, so a long reasoning gap does not read as a stall.
12. On Gemini tool-call follow-ups, reattaches `extra_content.google.thought_signature`
that OpenAI-only clients drop. Cached signatures from the previous Gemini response are preferred; otherwise Google's `skip_thought_signature_validator` sentinel is used so the request is not a quota-burning 400. If Gemini still returns that 400, remaining Gemini models for the same request are skipped.

Omitting `model`, or sending `free-best`, uses the free pool. Naming a free model ID tries every provider that currently offers that same model; naming an enabled paid model uses that selection. Use `provider:model` to force a single provider.
