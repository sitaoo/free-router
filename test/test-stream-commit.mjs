#!/usr/bin/env node
// Streaming commit grace: a thinking model streams reasoning deltas long before
// the first content delta. The router must not hold response headers hostage
// until content arrives (OpenWebUI/proxies time out the headerless wait and the
// user sees an empty reply), while fast empty streams must still fail over.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const mock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const reasoningBurst = async (count) => {
      for (let i = 0; i < count; i += 1) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `thinking-${i} ` }, finish_reason: null }] })}\n\n`,
        );
        await sleep(300);
      }
    };
    if (body.stream && body.model === 'slow-think') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      await reasoningBurst(10);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'slow-ok' }, finish_reason: null }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.stream && body.model === 'slow-hollow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      await reasoningBurst(10);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.stream && body.model === 'fast-empty') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thinking only' }, finish_reason: null }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    // One reasoning delta, then a long silence before content: the grace timer
    // must commit at its deadline, not wait for the next upstream read.
    if (body.stream && body.model === 'late-think') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thinking...' }, finish_reason: null }] })}\n\n`,
      );
      await sleep(2500);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'late-ok' }, finish_reason: null }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    // Headers, then silence forever: only the first-byte deadline can unstick
    // the request and let the next provider's offering answer.
    if (body.stream && body.model === 'stall-headers') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return;
    }
    // Not even headers: the same deadline has to cover the connect wait.
    if (body.stream && body.model === 'stall-connect') {
      return;
    }
    // Strict like Gemini's compatibility layer: any non-standard top-level
    // field (including stream_options when the provider says it cannot take
    // it) is a 400, not something to ignore.
    if (body.stream && body.model === 'strict-ok') {
      const allowed = new Set([
        'model',
        'messages',
        'stream',
        'temperature',
        'top_p',
        'n',
        'stop',
        'max_tokens',
        'max_completion_tokens',
        'presence_penalty',
        'frequency_penalty',
        'logit_bias',
        'logprobs',
        'top_logprobs',
        'user',
        'seed',
        'response_format',
        'tools',
        'tool_choice',
        'parallel_tool_calls',
        'reasoning_effort',
        'service_tier',
        'modalities',
        'audio',
        'prediction',
      ]);
      const unknown = Object.keys(body).filter((key) => !allowed.has(key));
      if (unknown.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unknown name "${unknown[0]}"` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'strict-ok' }, finish_reason: null }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    // A stream that dies after its first content chunk: the client must see
    // an error frame and [DONE], not a silent end (and no failover, since the
    // response was already committed).
    if (body.stream && body.model === 'drop-mid') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial-ok' }, finish_reason: null }] })}\n\n`,
      );
      await sleep(50);
      res.destroy();
      return;
    }
    // First content arrives fast, then the model keeps generating for a
    // while: latency accounting must record the first token, not the total.
    if (body.stream && body.model === 'slow-tail') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail-start' }, finish_reason: null }] })}\n\n`,
      );
      await sleep(2000);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail-end' }, finish_reason: null }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'fallback-ok' }, finish_reason: null }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'json-ok' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

await listen(mock);
const mockPort = mock.address().port;

// A second provider offering the same model slugs. Its answers are always
// healthy, so a stalled first offering must fail over to this one.
const healthy = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    for await (const _chunk of req) {
      // Drain the request body.
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'fallback-ok' }, finish_reason: null }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404).end();
});
await listen(healthy);
const healthyPort = healthy.address().port;

const portProbe = http.createServer();
await listen(portProbe);
const routerPort = portProbe.address().port;
await close(portProbe);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-stream-commit-'));
const testConfig = path.join(tempDir, 'config.json');
fs.writeFileSync(
  testConfig,
  JSON.stringify({
    host: '127.0.0.1',
    port: routerPort,
    attemptTimeoutMs: 20000,
    catalogRefreshMs: 3600000,
    defaultProvider: 'mock',
    routing: { explorePercent: 0 },
    // Both providers offer the same slugs, so naming one resolves to the
    // stalling offering first and the healthy copy as its failover. Provider
    // order decides the tie, and `mock` is listed first.
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${mockPort}`,
        keyEnv: 'STREAM_COMMIT_API_KEY',
        // This provider cannot take stream_options, like Gemini; the gateway
        // must drop it before sending.
        streamOptions: false,
        freeModels: [
          'slow-think',
          'slow-hollow',
          'fast-empty',
          'stall-headers',
          'stall-connect',
          'late-think',
          'strict-ok',
          'drop-mid',
          'slow-tail',
          'fallback-ok',
        ],
        chatPath: '/chat/completions',
      },
      healthy: {
        baseUrl: `http://127.0.0.1:${healthyPort}`,
        keyEnv: 'STREAM_COMMIT_API_KEY',
        freeModels: ['fallback-ok', 'fast-empty', 'stall-headers', 'stall-connect'],
        chatPath: '/chat/completions',
      },
    },
    discovery: { enabled: false },
    cooldownMs: {},
    usage: { retentionDays: 3, timezone: 'UTC' },
    webui: { enabled: false },
    gateway: { requireAuth: false, keys: [] },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, '..', 'app', 'server.mjs')], {
  env: {
    ...process.env,
    STREAM_COMMIT_API_KEY: 'test-key',
    FREE_ROUTER_CONFIG: testConfig,
    FREE_ROUTER_STREAM_COMMIT_GRACE_MS: '800',
    FREE_ROUTER_FIRST_BYTE_TIMEOUT_MS: '700',
    FREE_ROUTER_STREAM_KEEPALIVE_MS: '250',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => {
  childOutput += chunk;
});
child.stderr.on('data', (chunk) => {
  childOutput += chunk;
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await sleep(100);
  }
  throw new Error(`router did not start\n${childOutput}`);
}

function kill() {
  child.kill('SIGTERM');
}

// The router flushes state into tempDir on SIGTERM; removing the directory
// before the process exits races that write (ENOTEMPTY under load).
async function waitForExit() {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

try {
  await waitForHealth();

  // 1. Slow reasoning prefix: headers must arrive within the commit grace,
  // not after the full ~3s reasoning burst. (OpenWebUI times out otherwise.)
  {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'slow-think',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const ttfb = Date.now() - started;
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('x-free-router-request-id') || '',
      /^req_[0-9a-f]{16}$/,
      'every gateway response carries the request id used by the log',
    );
    assert.ok(ttfb < 2000, `TTFB ${ttfb}ms exceeds commit grace (headers held until content)`);
    const text = await response.text();
    assert.match(text, /slow-ok/);
    assert.match(text, /thinking-/);
    // Normalized chunks: the requested model (not the provider's), a chat
    // chunk object, and exactly one terminator.
    assert.match(text, /"model":"slow-think"/);
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.equal((text.match(/\[DONE\]/g) || []).length, 1);
  }

  // 2. Fast reasoning-only streams still fail over instead of committing. Both
  // providers offer `fast-empty`; the empty one ranks first.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fast-empty',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /fallback-ok/);
    assert.doesNotMatch(text, /thinking only/);
  }

  // 3. A stream that commits on reasoning but never yields content is hollow:
  // the client keeps its 200, but usage must record empty, never ok.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'slow-hollow',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /thinking-/);
    const health = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
    const entry = health.usage.models.find((model) => model.key === 'mock:slow-hollow');
    assert.ok(entry, 'hollow model has usage');
    assert.equal(entry.counts.ok || 0, 0);
    assert.ok((entry.counts.empty || 0) >= 1, `expected empty usage, got ${JSON.stringify(entry.counts)}`);
  }

  // 4. Commit deadline is a timer, not a side effect of the next read: one
  // reasoning delta followed by 2.5s of silence must still send headers at the
  // grace deadline, with keep-alives covering the gap until content arrives.
  {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'late-think',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    const ttfb = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(ttfb < 1800, `TTFB ${ttfb}ms: headers waited for the next upstream read`);
    const text = await response.text();
    assert.match(text, /late-ok/);
    assert.match(text, /: keep-alive/, 'keep-alive comment expected during the silent gap');
  }

  // 5. The Responses dialect gets the same early commit and starts with
  // response.created as soon as headers are sent.
  {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'late-think',
        input: 'hi',
        stream: true,
      }),
    });
    const ttfb = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(ttfb < 1800, `TTFB ${ttfb}ms: responses headers waited for the next read`);
    const text = await response.text();
    assert.match(text, /^event: response\.created/);
    assert.match(text, /late-ok/);
    assert.match(text, /event: response\.completed/);
  }

  // 6. A first candidate that sends headers then goes silent must hit the
  // first-byte deadline, not the 20s attempt timeout, so the next candidate
  // answers within the client's patience.
  {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'stall-headers',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 3000, `failover took ${elapsed}ms; first-byte deadline was not enforced`);
    assert.match(await response.text(), /fallback-ok/);
  }

  // 7. The same deadline covers a candidate that never sends headers at all.
  {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'stall-connect',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 3000, `failover took ${elapsed}ms; connect wait was not bounded`);
    assert.match(await response.text(), /fallback-ok/);
  }

  // 8. Client-only fields and an unsupported stream_options never reach the
  // upstream: the strict mock 400s on any non-standard top-level name.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'strict-ok',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.1,
        features: { web_search: true },
        variables: {},
        files: [],
        tool_ids: ['x'],
        metadata: { chat_id: 'abc' },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /strict-ok/);
  }

  // 9. An upstream that dies after committing yields an error frame and a
  // terminator instead of a silent truncated stream.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'drop-mid',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /partial-ok/);
    assert.match(text, /"type":"upstream_error"/);
    assert.match(text, /\[DONE\]/);
    assert.doesNotMatch(text, /fallback-ok/, 'a committed stream must not fail over');
  }

  // 10. Latency accounting uses the first useful token, not the duration of
  // the whole answer.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'slow-tail',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /tail-start/);
    assert.match(text, /tail-end/);
  }

  // The request log names the dialect and the top-level fields, never content.
  assert.match(
    childOutput,
    /chat request slow-think id=req_[0-9a-f]{16} fields=.*stream_options/,
    'the request line names the dialect, its id, and the top-level fields',
  );

  // Flush state, then verify the first-token sample landed instead of the
  // ~2.2s the slow-tail stream took end to end.
  kill();
  await waitForExit();
  const statePath = path.join(tempDir, 'discovered-free-models.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const latency = state.latency?.['mock:slow-tail'];
  assert.ok(latency, 'slow-tail latency was recorded');
  assert.equal(latency.n, 1);
  assert.ok(latency.meanMs < 1500, `recorded ${latency.meanMs}ms; expected first-token latency, not total`);

  console.log('stream-commit tests passed');
} finally {
  kill();
  await waitForExit();
  await close(mock);
  await close(healthy);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
