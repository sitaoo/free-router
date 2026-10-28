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
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${mockPort}`,
        keyEnv: 'STREAM_COMMIT_API_KEY',
        // The automatic pool tries the list in this order, so the failing
        // empty stream comes before the healthy fallback.
        freeModels: ['fast-empty', 'fallback-ok', 'slow-think', 'slow-hollow'],
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
    assert.ok(ttfb < 2000, `TTFB ${ttfb}ms exceeds commit grace (headers held until content)`);
    const text = await response.text();
    assert.match(text, /slow-ok/);
    assert.match(text, /thinking-/);
  }

  // 2. Fast reasoning-only streams still fail over instead of committing. No
  // model means the automatic free pool, which starts with the empty stream.
  {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

  console.log('stream-commit tests passed');
} finally {
  kill();
  await waitForExit();
  await close(mock);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
