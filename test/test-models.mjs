#!/usr/bin/env node
// /v1/models metadata: a model listed from a provider's allowlist must still
// report what that provider's catalog publishes about it.

import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviderRegistry } from '../app/providers.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Google's native listing: capabilities in supportedGenerationMethods, sizes in
// inputTokenLimit/outputTokenLimit, and no creation timestamp at all.
const googleModels = {
  models: [
    {
      name: 'models/gemini-x-flash',
      displayName: 'Gemini X Flash',
      description: 'Fast general model.',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-x-embed',
      inputTokenLimit: 2048,
      supportedGenerationMethods: ['embedContent'],
    },
  ],
};

// An OpenAI-shaped priced catalog, the way OpenRouter publishes one.
const openaiModels = {
  data: [
    {
      id: 'google/gemini-x-flash:free',
      object: 'model',
      created: 1712345678,
      name: 'Google: Gemini X Flash',
      description: 'Fast general model.',
      context_length: 1048576,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'response_format'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      top_provider: { context_length: 1048576, max_completion_tokens: 8192 },
      expiration_date: '2027-01-31',
    },
    {
      id: 'acme/paid-1',
      object: 'model',
      created: 1700000000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
    {
      id: 'acme/image-1',
      object: 'model',
      created: 1700000001,
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    },
  ],
};

const mock = http.createServer((req, res) => {
  // Google's listing is paginated, so the registry appends ?pageSize=1000.
  const pathname = req.url.split('?')[0];
  if (req.method === 'GET' && pathname === '/v1beta/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(googleModels));
    return;
  }
  if (req.method === 'GET' && pathname === '/openrouter/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(openaiModels));
    return;
  }
  res.writeHead(404).end();
});

await listen(mock);
const base = `http://127.0.0.1:${mock.address().port}`;

process.env.GEM_KEY = 'gem-key';
process.env.OR_KEY = 'or-key';

const registry = createProviderRegistry(
  {
    providers: {
      gem: {
        catalog: true,
        pricing: false,
        baseUrl: `${base}/v1beta/openai`,
        modelsUrl: `${base}/v1beta/models`,
        modelsKeyHeader: 'x-goog-api-key',
        keyEnv: 'GEM_KEY',
        freeModels: ['gemini-x-flash', 'gemini-x-gone'],
      },
      or: {
        catalog: true,
        pricing: true,
        baseUrl: `${base}/openrouter/v1`,
        keyEnv: 'OR_KEY',
      },
    },
  },
  { host: '127.0.0.1', port: 8787 },
);

await registry.refreshCatalogs(true, 0, () => {});
const listed = registry.listModels();
const byId = new Map(listed.models.map((model) => [model.id, model]));

// The allowlisted Gemini model now carries the sizes its catalog publishes,
// instead of the zeroes the old listing hard-coded.
const flash = byId.get('gemini-x-flash');
assert.ok(flash, 'allowlisted gemini model still listed');
assert.equal(flash.object, 'model');
assert.equal(flash.provider, 'gem');
assert.equal(flash.owned_by, 'gem');
assert.equal(flash.free, true);
assert.equal(flash.context_length, 1048576);
assert.equal(flash.max_output_tokens, 65536);
assert.equal(flash.description, 'Fast general model.');
assert.equal(flash.name, 'Gemini X Flash');
// Google publishes no creation time for its models, so the only honest
// timestamp is the one another provider gives for the same model.
assert.equal(flash.created, 1712345678);

// An allowlisted model the catalog no longer offers stays out, as before.
assert.equal(byId.has('gemini-x-gone'), false);
// Non-chat catalog entries never appear.
assert.equal(byId.has('gemini-x-embed'), false);

// A free model from a priced catalog keeps its published pricing and the
// capability list clients use to decide whether tools are available.
const free = byId.get('google/gemini-x-flash:free');
assert.ok(free, 'zero-cost catalog model listed');
assert.equal(free.provider, 'or');
assert.equal(free.owned_by, 'google');
assert.equal(free.created, 1712345678);
assert.equal(free.context_length, 1048576);
assert.equal(free.max_output_tokens, 8192);
assert.deepEqual(free.supported_parameters, ['tools', 'response_format']);
assert.deepEqual(free.input_modalities, ['text', 'image']);
assert.deepEqual(free.pricing, { prompt: '0', completion: '0' });
// A published retirement date is exactly what a free-model gateway wants to
// know, so it is carried through rather than dropped.
assert.equal(free.expiration_date, '2027-01-31');
assert.equal(flash.expiration_date, '2027-01-31', 'and shared with the same model elsewhere');

// Billed and non-chat models stay out of the free listing.
assert.equal(byId.has('acme/paid-1'), false);
assert.equal(byId.has('acme/image-1'), false);

// Allowlisted models come in provider order; catalog models follow, sorted.
assert.deepEqual(listed.models.map((model) => model.id), [
  'gemini-x-flash',
  'google/gemini-x-flash:free',
]);
assert.deepEqual([...listed.ids], ['gemini-x-flash']);

await close(mock);
console.log('models listing unit tests passed');
