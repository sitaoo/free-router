# OpenRouter Free Router

Local OpenAI-compatible gateway for Hermes Agent. It keeps an ordered list of
zero-cost OpenRouter models and falls back when a model is unavailable,
rate-limited, times out, or returns only reasoning with no content/tool call.

## Routes

- `free-best`: strongest general/coding models first
- `free-code`: coding-focused order
- `free-fast`: low-latency models first

Edit `config.json` to change ordering, timeout, and cooldowns.

## Run

The router reads `OPENROUTER_API_KEY` from the process environment or
`~/.hermes/.env`.

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

The selected upstream model is returned in the `X-Free-Router-Model` response
header and OpenRouter's normal `model` response field.

## Hermes

Add a model alias without replacing the current default:

```yaml
model_aliases:
  free-best:
    provider: custom
    model: free-best
    base_url: http://127.0.0.1:8787/v1
  free-code:
    provider: custom
    model: free-code
    base_url: http://127.0.0.1:8787/v1
  free-fast:
    provider: custom
    model: free-fast
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

1. Refreshes OpenRouter's catalog every 15 minutes.
2. Removes configured models that are no longer zero-cost.
3. Removes models missing capabilities required by the request, such as tools
   or image input.
4. Tries remaining models in configured order.
5. Applies cooldowns after rate limits, timeouts, server failures, and empty
   successful responses.
6. Buffers reasoning-only stream chunks. Nothing is sent to Hermes until a
   model emits content or a tool call, so an empty model can still be replaced.

When a concrete OpenRouter model ID is requested instead of one of the route
aliases, the gateway passes through to that model only.
