#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: ['mock-a', 'mock-b', 'mock-new', 'mock-audio'].map((id) => ({
          id,
          pricing:
            id === 'mock-b'
              ? { prompt: '0.000001', completion: '0.000001' }
              : { prompt: '0', completion: '0' },
          supported_parameters: ['tools', 'response_format'],
          architecture: {
            input_modalities: ['text'],
            output_modalities: id === 'mock-audio' ? ['text', 'audio'] : ['text'],
          },
        })),
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const isEvaluation = body.messages?.some(
      (message) => typeof message.content === 'string' && message.content.includes('OX-RANK-7'),
    );
    if (isEvaluation) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  token: 'OX-RANK-7',
                  crt: 269,
                  trace: '1-3',
                  path: 10,
                  sequence: 42,
                  binary: 55,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.model === 'mock-a') {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'thinking only' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({
            model: 'mock-b',
            choices: [{ delta: { content: 'router-ok' }, finish_reason: null }],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message:
              body.model === 'mock-a'
                ? { role: 'assistant', content: '', reasoning: 'thinking only' }
                : { role: 'assistant', content: 'router-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let tokenRouterRequests = 0;
const tokenRouterMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    tokenRouterRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-token-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tokenrouter rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'glm-5.3',
        choices: [
          {
            message: { role: 'assistant', content: 'tokenrouter-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let baiRequests = 0;
const baiMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    baiRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [{ delta: { content: 'bai-ok' }, finish_reason: null }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'bai-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let extraRequests = 0;
const extraMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    extraRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'extra-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

await listen(mock);
const mockPort = mock.address().port;
await listen(tokenRouterMock);
const tokenRouterPort = tokenRouterMock.address().port;
await listen(baiMock);
const baiPort = baiMock.address().port;
await listen(extraMock);
const extraPort = extraMock.address().port;

const portProbe = http.createServer();
await listen(portProbe);
const routerPort = portProbe.address().port;
await close(portProbe);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-test-'));
const testConfig = path.join(tempDir, 'config.json');
fs.writeFileSync(
  testConfig,
  JSON.stringify({
    host: '127.0.0.1',
    port: routerPort,
    attemptTimeoutMs: 5000,
    catalogRefreshMs: 1000,
    defaultProvider: 'openrouter',
    providers: {
      openrouter: {
        catalog: true,
        baseUrl: `http://127.0.0.1:${mockPort}/api/v1`,
        keyEnv: 'OPENROUTER_API_KEY',
      },
      tokenrouter: {
        baseUrl: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
        keyEnv: 'TOKENROUTER_API_KEY',
        freeModels: ['z-ai/glm-5.3-free'],
      },
      bai: {
        baseUrl: `http://127.0.0.1:${baiPort}/v1`,
        keyEnv: 'BAI_API_KEY',
        freeModels: ['glm-5.3-flash'],
      },
      extra: {
        baseUrl: `http://127.0.0.1:${extraPort}/v1`,
        keyEnv: 'EXTRA_API_KEY',
        freeModels: ['extra-1'],
      },
    },
    discovery: {
      enabled: true,
      provider: 'openrouter',
      intervalMs: 604800000,
      route: 'test-route',
      stateFile: 'discovered-free-models.json',
      evaluation: {
        enabled: true,
        pinnedModels: ['tokenrouter:z-ai/glm-5.3-free', 'bai:glm-5.3-flash'],
        baselineScores: { 'mock-b': 80 },
      },
    },
    cooldownMs: {},
    routes: {
      'test-route': [
        { provider: 'tokenrouter', model: 'z-ai/glm-5.3-free' },
        { provider: 'bai', model: 'glm-5.3-flash' },
        'mock-a',
        'mock-b',
        { provider: 'extra', model: 'extra-1' },
      ],
    },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`,
    TOKENROUTER_API_KEY: 'token-test-key',
    TOKENROUTER_BASE_URL: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
    BAI_API_KEY: 'bai-test-key',
    BAI_BASE_URL: `http://127.0.0.1:${baiPort}/v1`,
    EXTRA_API_KEY: 'extra-test-key',
    EXTRA_BASE_URL: `http://127.0.0.1:${extraPort}/v1`,
    FREE_ROUTER_CONFIG: testConfig,
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
      if (response.ok) {
        const health = await response.json();
        if (health.discovery?.lastCheckedAt) return health;
      }
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router did not start\n${childOutput}`);
}

try {
  const health = await waitForHealth();
  assert.deepEqual(health.discovery.addedModels, ['mock-new']);
  assert.deepEqual(
    health.routes['test-route'].map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      'openrouter:mock-new',
      'openrouter:mock-a',
      'extra:extra-1',
    ],
  );
  assert.equal(health.defaultProvider, 'openrouter');
  assert.equal(health.discovery.provider, 'openrouter');
  assert.equal(health.providers.openrouter.kind, 'catalog');
  assert.equal(health.providers.extra.kind, 'static');
  assert.equal(health.providers.extra.configured, true);
  assert.deepEqual(health.discovery.removedModels, ['mock-b']);
  assert.equal(health.discovery.evaluations['mock-new'].status, 'scored');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(tempDir, 'discovered-free-models.json'), 'utf8'))
      .addedModels[0],
    'mock-new',
  );
  const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.deepEqual(
    models.data.map((model) => model.id),
    ['test-route', 'z-ai/glm-5.3-free', 'glm-5.3-flash', 'extra-1', 'mock-a', 'mock-new'],
  );
  const request = {
    model: 'test-route',
    messages: [{ role: 'user', content: 'force-token-failure' }],
  };

  const jsonResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(jsonResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const json = await jsonResponse.json();
  assert.equal(json.model, 'glm-5.3-flash');
  assert.equal(json.choices[0].message.content, 'bai-ok');

  const streamResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    },
  );
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(streamResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const stream = await streamResponse.text();
  assert.match(stream, /bai-ok/);
  assert.doesNotMatch(stream, /thinking only/);

  const directTokenRouterResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-free',
        messages: [{ role: 'user', content: 'token-success' }],
      }),
    },
  );
  assert.equal(directTokenRouterResponse.status, 200);
  assert.equal(
    directTokenRouterResponse.headers.get('x-free-router-provider'),
    'tokenrouter',
  );
  assert.equal(
    (await directTokenRouterResponse.json()).choices[0].message.content,
    'tokenrouter-ok',
  );

  const updatedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(updatedHealth.lastSelection.route, 'z-ai/glm-5.3-free');
  assert.equal(updatedHealth.lastSelection.provider, 'tokenrouter');
  assert.equal(updatedHealth.lastSelection.model, 'z-ai/glm-5.3-free');
  const directBaiResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'bai-success' }],
      }),
    },
  );
  assert.equal(directBaiResponse.status, 200);
  assert.equal(directBaiResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal((await directBaiResponse.json()).choices[0].message.content, 'bai-ok');

  const afterBaiHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(afterBaiHealth.lastSelection.provider, 'bai');
  assert.equal(afterBaiHealth.lastSelection.model, 'glm-5.3-flash');

  const directExtraResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'extra-success' }],
      }),
    },
  );
  assert.equal(directExtraResponse.status, 200);
  assert.equal(directExtraResponse.headers.get('x-free-router-provider'), 'extra');
  assert.equal((await directExtraResponse.json()).choices[0].message.content, 'extra-ok');
  assert.ok(extraRequests >= 1);

  assert.ok(tokenRouterRequests >= 3);
  assert.ok(baiRequests >= 3);

  console.log('smoke test passed: pluggable providers, ranking, fallback, discovery, and tracking work');
} finally {
  child.kill('SIGTERM');
  await close(mock);
  await close(tokenRouterMock);
  await close(baiMock);
  await close(extraMock);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
