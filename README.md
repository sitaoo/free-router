# Free Router

Local OpenAI-compatible gateway. Providers are pluggable and sit side by
side. `free-best` is one ranked list across all of them; the first currently
free, capable, not-cooling-down candidate wins. If a provider is unavailable,
rate-limited, times out, or returns only reasoning with no content or tool
call, the next model in that shared ranking is tried.

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1` and use the
`free-best` model.

## Requirements

- Node.js 20+
- An API key for at least one provider in `config.json`

A missing key just drops that provider from ranking.

## Configure API keys

Keys are never stored in `config.json` or committed to git. Copy the example
file, uncomment the keys you have, and fill them in:

```bash
cp .env.example .env
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes, for OpenRouter fallbacks and model discovery | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | No | Your TokenRouter account |
| `BAI_API_KEY` | No | [chat.b.ai](https://chat.b.ai) API keys. One key covers all official B.AI models |

Any later provider named `foo` reads `FOO_API_KEY` and `FOO_BASE_URL` unless
you override `keyEnv` / `baseUrlEnv` in config.

Lookup order, first non-empty value wins:

1. Process environment (`export OPENROUTER_API_KEY=...`)
2. `.env` in the project directory
3. `~/.hermes/.env`, if you already keep keys there

`.env` is gitignored. Do not put keys in the systemd unit, README, or config.

Optional settings are listed in `.env.example`: listen address, upstream base
URLs, and the OpenRouter app title/referer.

## Run

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
cp .env.example .env
# edit .env and set the keys you have
./start.sh
```

The gateway listens on `127.0.0.1:8787` by default. Stop it with `./stop.sh`.
Run these scripts as a normal user. If started as root, they re-exec as the
directory owner and refuse to stay root.

Foreground:

```bash
node server.mjs
```

## Use with any OpenAI-compatible client

The local server does not authenticate callers. Keep it bound to localhost.
Upstream provider keys stay on the gateway.

**curl**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
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

The selected upstream is returned in `X-Free-Router-Provider` and
`X-Free-Router-Model`, plus the provider's normal `model` field.

## Endpoints

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`GET /v1/models` returns the route alias, each static provider's `freeModels`,
and every currently free text-chat model from catalog providers. A listed
concrete model ID can be selected directly to bypass fallback routing. Prefix
with `provider:` when the same ID could exist on more than one provider.

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Routes

- `free-best`: one ranked list across every configured provider

Edit `config.json` to change ordering, timeout, and cooldowns. Pin entries with
`provider:model` in `discovery.evaluation.pinnedModels`. Models without a key,
or that are no longer free, are skipped.

## Add a provider

No code change is needed for an OpenAI-compatible `/chat/completions` endpoint.
The registry in `providers.mjs` loads every block under `config.json`
`providers`.

1. Add a provider object. Use `"catalog": true` if it exposes `GET /models`
   with zero-cost pricing, otherwise list `freeModels`.
2. Insert `{ "provider": "<name>", "model": "<id>" }` into `routes.free-best`
   where you want it ranked. Bare strings belong to `defaultProvider`.
3. Optionally pin `name:model` in `discovery.evaluation.pinnedModels`.
4. Set `<NAME>_API_KEY` in `.env` or `~/.hermes/.env`. Override the URL with
   `<NAME>_BASE_URL` if needed.
5. Restart.

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

Optional fields: `keyEnv`, `baseUrlEnv`, `headers`, `chatPath`, `modelsPath`,
and `discover: false` to keep a catalog provider out of weekly discovery.
Weekly discovery runs against `discovery.provider` (default: first catalog
provider).

## Weekly free-model discovery

The router checks the discovery catalog provider once a week for newly free
text-generation models. Each new model receives one cached hybrid evaluation
using deterministic reasoning/instruction checks, response latency, context
size, and tool/structured output support. Its score places it among the
manually ranked models in `free-best`. Existing models are not reevaluated or
reordered during later checks. Failed or rate-limited new model evaluations
stay at the end.

If a routed catalog model becomes paid, disappears, or stops qualifying as a
text chat model, the next catalog check removes it from every effective route
automatically. It remains in `config.json` as ranking history and becomes
active again only if that catalog lists it as free in the future. Static
provider candidates stay in the ranking as long as they are listed under
`freeModels` and a key is set.

Discovery and evaluation state is stored in `discovered-free-models.json` and
survives service restarts. That file is gitignored.

Configure the schedule and destination route in `config.json`:

```json
"discovery": {
  "enabled": true,
  "provider": "openrouter",
  "intervalMs": 604800000,
  "route": "free-best",
  "stateFile": "discovered-free-models.json",
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "pinnedModels": [
      "tokenrouter:z-ai/glm-5.3-free",
      "bai:glm-5.3-flash"
    ]
  }
}
```

`/health` reports the last collection time, free models seen, scores, route
priority, and models removed because they are no longer free. Existing route
positions act as baseline score anchors; optional `baselineScores` entries
under `evaluation` can override an individual model's anchor score.

## systemd user service

The unit assumes the repo lives at `~/free-router`. If you cloned somewhere
else, edit `WorkingDirectory` and `ExecStart` before enabling it.

```bash
mkdir -p ~/.config/systemd/user
cp free-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router
journalctl --user -u free-router -f
```

`./start.sh` also works without systemd.

## Routing behavior

1. Builds one candidate list from `free-best` across every configured
   provider. Pinned models stay first, in config order; the rest follow
   baseline rank and discovery scores.
2. Skips a provider when its API key is missing.
3. Refreshes catalog providers every 15 minutes.
4. Collects newly free catalog text models weekly, evaluates them once, and inserts them
   into `free-best` by score.
5. Removes catalog models that are no longer free, available, or text-chat compatible
   from effective routes.
6. Removes models missing capabilities required by the request, such as tools
   or image input.
7. Tries remaining models in that unified order.
8. Applies per-provider/model cooldowns after rate limits, timeouts, server failures, and empty
   successful responses.
9. Buffers reasoning-only stream chunks. Nothing is sent to the client until a
   model emits content or a tool call, so an empty model can still be replaced.

When a concrete model ID is requested instead of a route alias, the gateway
sends it to a matching static listing, then to catalog providers.
Use `provider:model` to force a provider.
