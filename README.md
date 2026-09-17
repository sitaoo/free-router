# Free Router

> English | [中文](docs/zh-CN/README.md)

<p align="center">
  <img src="docs/og.png" alt="Free Router architecture: any OpenAI client to a local gateway to pluggable providers" width="100%">
</p>

Local OpenAI-compatible gateway. Point any client at
`http://127.0.0.1:8787/v1` and use `free-best`. It ranks currently free
models across **any OpenAI-compatible provider you configure**, then fails
over when one is rate-limited, down, or empty. A missing key just drops that
provider.

Site: [www222fff.github.io/free-router](https://www222fff.github.io/free-router/)

## Run (Web UI first)

Node.js 20+. Clone and start — everything else happens in the web UI:

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
./ctl.sh start
```

Open <http://127.0.0.1:8787/> and log in (default password `admin123`).
From there, no config files needed:

- **Providers tab** — paste your keys; multiple keys per provider rotate
  automatically, a `401` retires only that key
- **Access tab** — create gateway API keys for `/v1/*` clients
- **Routes tab** — order the models each route tries
- **Quotas tab** — daily limits and usage history
- **Settings tab** — server, discovery, tuning, and the **Allow LAN access**
  switch (shows the exact addresses to use, container-aware)

The interface follows your browser language (12 languages included).
`./ctl.sh stop` stops it; `./ctl.sh restart`, `./ctl.sh status`, and
`./ctl.sh docker [--dev]` cover the rest. See [How it works](docs/HOW_IT_WORKS.md).

| Variable | Where |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |

Need more than one key per provider? `OPENROUTER_API_KEYS` (or
`OPENROUTER_API_KEY_KEYS`), comma-separated — or add named keys in the web
UI. Requests rotate across them automatically.

More providers: add one in the web UI with just a name and a base URL, or add
a block in `app/config/config.json`.

## LAN access

Settings → **Allow LAN access** shows every reachable address
(`{lan-ip}`, `127.0.0.1`, `localhost`, `{hostname}`). Before exposing
anything:

1. Create a gateway API key in the web UI (Access tab) — `/v1/*` requires
   `Authorization: Bearer <key>` once a key exists.
2. Change the admin password (Settings tab).

Call it like any OpenAI endpoint, plus the key:

```bash
curl -s http://<lan-ip>:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{"model": "free-best", "messages": [{"role": "user", "content": "hi"}]}'
```

## Project layout

```text
app/            code (server, providers, UI, config module)
app/cli/        list-models command
app/config/     tracked defaults (config.json)
test/           unit + smoke tests (`npm test` from the repo root)
data/           the only writable dir (overlay, state, .env seed, logs)
script/         start/stop/models/migrate helpers, systemd unit
docker/         Dockerfile, compose.yaml (prod base), compose.override.yaml (dev)
ctl.sh          front door: start/stop/restart/service/docker/status
```

## Configuration layers

`app/config/config.json` holds defaults and stays merge-clean. Everything you
change in the web UI is written to the gitignored `data/config.local.json`,
which wins over defaults at startup (objects merge per key, arrays are
replaced). Full precedence, highest first: explicit process environment →
`data/config.local.json` → first-boot `.env` seed → `app/config/config.json`.

```bash
./script/models.sh          # current free-best order
./script/models.sh --usage  # today's quota
```

## `.env` (optional)

The web UI is the primary way to configure; `.env` is a convenience seed.
`mkdir -p data && cp .env.example data/.env`, fill in keys (and
`FREE_ROUTER_HOST=0.0.0.0` for LAN), and values are migrated into
`data/config.local.json` on first boot. Afterwards `.env` files are ignored
so UI edits always stick; explicit process environment still wins over
everything. Provider keys also work straight from the environment, so keys can
live outside any file entirely.
