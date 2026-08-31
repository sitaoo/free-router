# OpenRouter Free Router

Local OpenAI-compatible gateway for Hermes Agent. It tries TokenRouter's free
GLM-5.3 first, then falls back through an ordered list of zero-cost OpenRouter
models when a provider is unavailable, rate-limited, times out, or returns only
reasoning with no content/tool call.

## Routes

- `free-best`: TokenRouter GLM-5.3 first, then OpenRouter fallbacks

Edit `config.json` to change ordering, timeout, and cooldowns.

## Weekly free-model discovery

The router checks OpenRouter once a week for newly free text-generation models.
Each new model receives one cached hybrid evaluation using deterministic
reasoning/instruction checks, response latency, context size, and tool/structured
output support. Its score places it among the manually ranked models in
`free-best`; Ox Alpha remains pinned first while it is free. Existing models are
not reevaluated or reordered during later checks. Failed or rate-limited new
model evaluations stay at the end.

If a routed model becomes paid, disappears from OpenRouter, or stops qualifying
as a text chat model, the next catalog check removes it from every effective
route automatically. It remains in `config.json` as ranking history and becomes
active again only if OpenRouter lists it as free in the future.

Discovery and evaluation state is stored in `discovered-free-models.json` and
survives service restarts.

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
    "pinnedModels": ["stealth/ox-alpha"]
  }
}
```

The `/health` response reports the last collection time, number of free models
seen, benchmark details, scores, and resulting route priority. Existing route
positions act as baseline score anchors; optional `baselineScores` entries under
`evaluation` can override an individual model's anchor score. It also lists
models removed because they are no longer free or available.

## Run

The router reads `TOKENROUTER_API_KEY` and `OPENROUTER_API_KEY` from the
process environment or `~/.hermes/.env`.

```bash
cd /home/dannyaw/openrouter-free-router
npm run check
./start.sh
```

It listens only on `127.0.0.1:8787` by default.

Stop it with:

```bash
./stop.sh
```

## Endpoints

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`GET /v1/models` returns the route alias, TokenRouter's configured free models,
and every currently free text-chat model from OpenRouter. A listed concrete
model ID can be selected directly to bypass fallback routing.

Inspect route health and cooldowns:

```bash
curl -s http://127.0.0.1:8787/health | jq
```

Test a non-streaming completion:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "free-best",
    "messages": [{"role": "user", "content": "Reply with exactly: router-ok"}]
  }' | jq
```

The selected upstream is returned in the `X-Free-Router-Provider` and
`X-Free-Router-Model` response headers, plus the provider's normal `model`
response field.

## Hermes

Add a model alias without replacing the current default:

```yaml
model_aliases:
  free-best:
    provider: custom
    model: free-best
    base_url: http://127.0.0.1:8787/v1
```

Switch in any Hermes chat:

```text
/model free-best
```

## systemd user service

Use this only on a Linux session with a working systemd user bus. The included
`start.sh` is the default for this WSL installation.

```bash
mkdir -p ~/.config/systemd/user
cp openrouter-free-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openrouter-free-router
```

View logs:

```bash
journalctl --user -u openrouter-free-router -f
```

## Routing behavior

1. Tries the configured TokenRouter free model first.
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
8. Buffers reasoning-only stream chunks. Nothing is sent to Hermes until a
   model emits content or a tool call, so an empty model can still be replaced.

When a concrete OpenRouter model ID is requested instead of one of the route
aliases, the gateway passes through to that model only.
