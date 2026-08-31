# Free Router

Local OpenAI-compatible gateway. It tries TokenRouter's free GLM-5.3 first,
then falls back through an ordered list of zero-cost OpenRouter models when a
provider is unavailable, rate-limited, times out, or returns only reasoning
with no content or tool call.

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1` and use the
`free-best` model.

## Requirements

- Node.js 20+
- An [OpenRouter](https://openrouter.ai/keys) API key
- Optional: a TokenRouter API key, if you want TokenRouter tried first

## Configure API keys

Keys are never stored in `config.json` or committed to git. Copy the example
file, uncomment the keys you have, and fill them in:

```bash
cp .env.example .env
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes, for OpenRouter fallbacks and model discovery | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | No | Your TokenRouter account. If unset, `free-best` skips TokenRouter and uses OpenRouter only |

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
# edit .env and set OPENROUTER_API_KEY, plus TOKENROUTER_API_KEY if you have one
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

`GET /v1/models` returns the route alias, TokenRouter's configured free models,
and every currently free text-chat model from OpenRouter. A listed concrete
model ID can be selected directly to bypass fallback routing.

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Routes

- `free-best`: TokenRouter GLM-5.3 first, then OpenRouter fallbacks

Edit `config.json` to change ordering, timeout, and cooldowns.

## Weekly free-model discovery

The router checks OpenRouter once a week for newly free text-generation models.
Each new model receives one cached hybrid evaluation using deterministic
reasoning/instruction checks, response latency, context size, and tool/structured
output support. Its score places it among the manually ranked models in
`free-best`. Existing models are not reevaluated or reordered during later
checks. Failed or rate-limited new model evaluations stay at the end.

If a routed model becomes paid, disappears from OpenRouter, or stops qualifying
as a text chat model, the next catalog check removes it from every effective
route automatically. It remains in `config.json` as ranking history and becomes
active again only if OpenRouter lists it as free in the future.

Discovery and evaluation state is stored in `discovered-free-models.json` and
survives service restarts. That file is gitignored.

Configure the schedule and destination route in `config.json`:

```json
"discovery": {
  "enabled": true,
  "intervalMs": 604800000,
  "route": "free-best",
  "stateFile": "discovered-free-models.json",
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "pinnedModels": ["tokenrouter:z-ai/glm-5.3-free"]
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

1. Tries the configured TokenRouter free model first when `TOKENROUTER_API_KEY` is set.
2. Refreshes OpenRouter's catalog every 15 minutes.
3. Collects newly free OpenRouter text models weekly, evaluates them once, and inserts them
   into `free-best` by score.
4. Removes OpenRouter models that are no longer free, available, or text-chat compatible
   from effective routes.
5. Removes models missing capabilities required by the request, such as tools
   or image input.
6. Tries remaining models in configured order.
7. Applies per-provider/model cooldowns after rate limits, timeouts, server failures, and empty
   successful responses.
8. Buffers reasoning-only stream chunks. Nothing is sent to the client until a
   model emits content or a tool call, so an empty model can still be replaced.

When a concrete OpenRouter model ID is requested instead of a route alias, the
gateway passes through to that model only.
