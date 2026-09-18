# Free Router

> English | [中文](docs/zh-CN/README.md)

<p align="center">
  <img src="docs/og.png" alt="Free Router architecture: any OpenAI client to a local gateway to pluggable providers" width="100%">
</p>

Turn scattered **free-tier models** into one **inexhaustible OpenAI endpoint**.
Point any client at it and call `free-best`: when a model is rate-limited, down, or out of quota, the next one takes over automatically.

- **Zero dependencies**: pure Node standard library. No `npm install`, no supply-chain baggage.
- **Works out of the box**: generates its own default config on first boot. Open the browser and configure.
- **Key freedom**: multiple keys per provider rotate automatically. A `401` retires only the bad one.
- **Transparent quotas**: free allowances tracked per day. Exhausted models step aside and return tomorrow.
- **LAN ready**: one switch plus gateway auth. Phones, tablets, and other machines at home can use it.
- **Speaks your language**: 12 UI languages, following the browser automatically.

Site: [www222fff.github.io/free-router](https://www222fff.github.io/free-router/)

## 60-second start

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
./ctl.sh start          # Node 20+ only, nothing else needed
```

Open <http://127.0.0.1:8787/> and log in (default password `admin123`).
Paste at least one key on the **Providers** tab, then:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "free-best", "messages": [{"role": "user", "content": "hi"}]}'
```

That is it.
Route order, quotas, LAN access, gateway keys — the rest is all point-and-click in the UI.
`./ctl.sh stop` stops it, `./ctl.sh status` checks it.

## What it does behind the scenes

- **Discovers every two days**: scans provider catalogs. New free models pass a capability exam before joining the ranking.
- **Ranks live on every request**: config order sets the baseline. Real success rates, cooldowns, and daily limits weigh in. Pinned models always go first.
- **Scores on a 0-100 scale**: capability portrait, scarcity, and live latency refine the order; a few percent of traffic samples cold models. Details: [Scoring scale and live signals](docs/HOW_IT_WORKS.md#scoring-scale-and-live-signals).
- **Bad keys do not implicate anyone**: a `401` retires only the current key. Rate limits only cool down the current key. The model record stays clean.
- **Settings never get lost**: factory defaults and your changes live in separate files. `git pull` can never clobber them.
- **Runs anywhere**: foreground, `systemd`, Docker containers. Everything writable lives in the single `data/` directory.

## Going further

```bash
./script/models.sh          # live free-best ranking
./script/models.sh --usage  # who burned how much quota
./ctl.sh docker --dev       # Docker dev mode (live code mount)
```

- LAN: Settings → **Allow LAN access**. It lists the exact addresses. Create a gateway key and change the password first.
- New provider: name plus base URL in the web UI, or a block in `app/config/config.json`.
- Design and config layers: [How it works](docs/HOW_IT_WORKS.md).

## Where to get keys

| Variable | Where |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |

Naming rule: `FOO_API_KEY` plus `FOO_BASE_URL`. Any OpenAI-compatible provider works. Multiple keys, comma-separated.

## `.env` (optional)

The web UI is the primary way to configure. `.env` is a convenience seed.
`mkdir -p data && cp .env.example data/.env` and fill it in.
First-boot values migrate into `data/config.local.json`. Afterwards `.env` files are ignored so UI edits always stick.
Explicit process environment still wins over everything.
Provider keys also work straight from the environment, so keys can live outside any file entirely.
