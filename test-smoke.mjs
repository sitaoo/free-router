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

await listen(mock);
const mockPort = mock.address().port;

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
    discovery: {
      enabled: true,
      intervalMs: 604800000,
      route: 'test-route',
      stateFile: 'discovered-free-models.json',
      evaluation: {
        enabled: true,
        pinnedModels: ['mock-a'],
        baselineScores: { 'mock-b': 80 },
      },
    },
    cooldownMs: {},
    routes: { 'test-route': ['mock-a', 'mock-b'] },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`,
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
      if (response.ok) return response.json();
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
    health.routes['test-route'].map((entry) => entry.id),
    ['mock-a', 'mock-new'],
  );
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
    ['test-route', 'mock-a', 'mock-new'],
  );
  const request = {
    model: 'test-route',
    messages: [{ role: 'user', content: 'test' }],
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
  assert.equal(jsonResponse.headers.get('x-free-router-model'), 'mock-new');
  const json = await jsonResponse.json();
  assert.equal(json.model, 'mock-new');
  assert.equal(json.choices[0].message.content, 'router-ok');

  const streamResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    },
  );
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('x-free-router-model'), 'mock-new');
  const stream = await streamResponse.text();
  assert.match(stream, /router-ok/);
  assert.doesNotMatch(stream, /thinking only/);

  const updatedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(updatedHealth.lastSelection.route, 'test-route');
  assert.equal(updatedHealth.lastSelection.model, 'mock-new');

  console.log('smoke test passed: model listing, discovery, fallback, and selection tracking work');
} finally {
  child.kill('SIGTERM');
  await close(mock);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
