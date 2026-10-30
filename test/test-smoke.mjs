#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isChatModel, normalizeCatalogPayload, normalizeModelSlug, supportsRequest } from '../app/providers.mjs';
import { msUntilQuotaReset, parseQuotaFailure, permanentRejection } from '../app/quota.mjs';
import {
  SKIP_THOUGHT_SIGNATURE,
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  readThoughtSignature,
  rememberSignaturesFromPayload,
} from '../app/thought-signature.mjs';
import { displayPath, maskSecret, validateSecret } from '../app/ui.mjs';
import {
  hashPassword,
  hashPasswordAsync,
  isPasswordHash,
  verifyPassword,
  verifyPasswordAsync,
} from '../app/auth.mjs';
import {
  addMissingKeys,
  buildLiveConfig,
  deepMerge,
  defaultConfigObject,
  runOverlayMigrations,
  SCHEMA_VERSION,
} from '../app/config.mjs';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;
assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);

assert.equal(normalizeModelSlug('google/gemini-3.8-flash:free'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('gemini-3.8-flash'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('acme/extra-1:free'), 'extra-1');

// Google's native listing, in the shape the live API returns it.
const googleCatalog = normalizeCatalogPayload({
  models: [
    {
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      description: 'Fast general model.',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-embedding-2',
      supportedGenerationMethods: ['embedContent', 'countTextTokens'],
    },
    {
      name: 'models/veo-3.1-generate-preview',
      supportedGenerationMethods: ['predictLongRunning'],
    },
    {
      name: 'models/gemini-3.1-flash-live-preview',
      supportedGenerationMethods: ['bidiGenerateContent'],
    },
  ],
});
assert.equal(googleCatalog.shape, 'google');
// The "models/" prefix is dropped so catalog IDs match what config.json and
// the chat endpoint use.
assert.deepEqual(
  googleCatalog.models.map((model) => model.id),
  ['gemini-3.8-flash', 'gemini-embedding-2', 'veo-3.1-generate-preview', 'gemini-3.1-flash-live-preview'],
);
assert.equal(googleCatalog.models[0].context_length, 1048576);
// Declared generation methods decide chat capability; embeddings, video, and
// live audio are excluded without naming them anywhere.
assert.deepEqual(googleCatalog.models.map(isChatModel), [true, false, false, false]);
// A listing with no prices must never read as free.
assert.equal(googleCatalog.models[0].pricing, undefined);
// And no OpenAI-style parameter list: treating that as "no tools" would skip
// Gemini on every agent request and dump traffic onto whatever has no catalog.
assert.equal(googleCatalog.models[0].supported_parameters, undefined);
{
  const tools = { tools: true, responseFormat: false, modalities: new Set() };
  const images = { tools: false, responseFormat: false, modalities: new Set(['image']) };
  assert.equal(supportsRequest(googleCatalog.models[0], tools), true);
  assert.equal(supportsRequest(googleCatalog.models[0], images), true);
  assert.equal(supportsRequest({ supported_parameters: [] }, tools), true);
  assert.equal(supportsRequest(null, tools), true);
  assert.equal(supportsRequest({ supported_parameters: ['response_format'] }, tools), false);
  assert.equal(supportsRequest({ supported_parameters: ['tools'] }, tools), true);
  assert.equal(
    supportsRequest({ architecture: { input_modalities: ['text'] } }, images),
    false,
  );
}

const openaiCatalog = normalizeCatalogPayload({ data: [{ id: 'a' }, { nope: 1 }] });
assert.equal(openaiCatalog.shape, 'openai');
assert.deepEqual(openaiCatalog.models.map((model) => model.id), ['a']);
assert.equal(normalizeCatalogPayload({ weird: true }).shape, 'unknown');

// `generateContent` is necessary but not sufficient: Google serves images,
// speech, and music through the same method, so the exclusion patterns in
// the default config carry the rest. These are the real IDs the live listing returns.
{
  const patterns = defaultConfigObject().discovery.exclude.modelPatterns.map(
    (source) => new RegExp(source, 'i'),
  );
  const excluded = (id) => patterns.some((pattern) => pattern.test(`gemini:${id}`));

  for (const id of [
    'gemini-2.5-flash-preview-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-3-pro-image',
    'gemini-3.1-flash-lite-image',
    'nano-banana-pro-preview',
    'lyria-3.5',
    'lyria-3-clip-preview',
    'gemini-3.5-transcribe',
    'gemini-robotics-er-2-preview',
    'gemini-2.5-computer-use-preview-10-2025',
    'deep-research-pro-preview-12-2025',
    'antigravity-preview-05-2026',
    // Moving aliases: they resolve to a concrete model that is ranked and
    // quota-tracked separately, so routing both double-counts one allowance.
    'gemini-flash-latest',
    'gemini-pro-latest',
  ]) {
    assert.equal(excluded(id), true, `should be excluded: ${id}`);
  }

  for (const id of [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview',
    'gemma-4-31b-it',
    'gemini-omni-flash-preview',
  ]) {
    assert.equal(excluded(id), false, `should stay a candidate: ${id}`);
  }
}

// Discovery must be able to ask every price-free catalog, not just OpenRouter.
{
  const defaults = defaultConfigObject();
  assert.equal(defaults.providers.gemini.probeFreeTier, true);
  assert.equal(defaults.providers.tokenrouter.probeFreeTier, true);
  assert.equal(defaults.providers.bai.catalog, true);
  assert.equal(defaults.providers.bai.probeFreeTier, true);
  assert.equal(defaults.providers.hashneuron.baseUrl, 'https://hashneuron.space/v1');
  assert.equal(defaults.providers.hashneuron.catalog, true);
  assert.equal(defaults.providers.hashneuron.pricing, false);
  assert.equal(defaults.providers.hashneuron.probeFreeTier, true);
}

// Verbatim from a live 429 for gemini-3.1-pro-preview on a free-tier key.
const noFreeTierBody = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. ' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\nPlease retry in 56.713473252s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56.713473252s' },
    ],
  },
};
const noFreeTier = parseQuotaFailure(noFreeTierBody);
assert.equal(noFreeTier.noFreeTier, true);
assert.equal(noFreeTier.dailyRequestLimit, null);
assert.equal(noFreeTier.exhaustedWindow, '');
assert.equal(noFreeTier.retryDelayMs, 56714);
// The per-day requests allowance is paired with its window, not just its number.
assert.equal(
  noFreeTier.limits.find((entry) => entry.quotaId.startsWith('GenerateRequestsPerDay')).window,
  'day',
);

// Same shape, but the allowance exists and is merely spent: this must not be
// mistaken for a model that has no free tier.
const exhaustedBody = structuredClone(noFreeTierBody);
exhaustedBody.error.message = exhaustedBody.error.message
  .replace(/generate_content_free_tier_requests, limit: 0/g, 'generate_content_free_tier_requests, limit: 20')
  .replace(
    /generate_content_free_tier_input_token_count, limit: 0/g,
    'generate_content_free_tier_input_token_count, limit: 1000000',
  );
const exhausted = parseQuotaFailure(exhaustedBody);
assert.equal(exhausted.noFreeTier, false);
assert.equal(exhausted.dailyRequestLimit, 20);
assert.equal(exhausted.exhaustedWindow, 'day');

// The decisive case: one free-tier allowance is spent while another reads
// zero. Only a model with no nonzero allowance anywhere lacks a free tier, so
// treating "any zero" as proof would permanently drop a working model.
const mixedBody = structuredClone(noFreeTierBody);
mixedBody.error.message = mixedBody.error.message.replace(
  /generate_content_free_tier_requests, limit: 0/g,
  'generate_content_free_tier_requests, limit: 20',
);
const mixed = parseQuotaFailure(mixedBody);
assert.equal(mixed.noFreeTier, false);
assert.equal(mixed.dailyRequestLimit, 20);

assert.equal(parseQuotaFailure({ error: { message: 'nothing to do with quota' } }), null);

assert.match(
  permanentRejection(404, {
    error: { message: 'This model models/gemini-2.5-pro is no longer available to new users.' },
  }),
  /withdrawn/,
);
assert.match(permanentRejection(404, {}), /not served here/);
assert.match(
  permanentRejection(400, { error: { message: 'This model only supports Interactions API.' } }),
  /not a chat/,
);
assert.equal(permanentRejection(429, { error: { message: 'quota' } }), '');

// A daily quota resets at Pacific midnight, so the wait is until that boundary
// rather than a fixed interval. In September that is UTC-7, and the result
// carries a one minute cushion so the retry lands past the boundary.
const minute = 60000;
// 23:50 Pacific: ten minutes left in the quota day.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T06:50:00Z')), 11 * minute);
// 01:05 Pacific: almost a full day to wait, and notably not a fixed 10 minutes.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T08:05:00Z')), (22 * 60 + 56) * minute);

// Paths shown in the interface or the log must not carry the username.
assert.equal(displayPath(path.join(os.homedir(), 'free-router', '.env')), '~/free-router/.env');
assert.equal(displayPath(os.homedir()), '~');
assert.equal(displayPath('/etc/free-router/.env'), '/etc/free-router/.env');
assert.equal(displayPath(''), '');

assert.equal(maskSecret('').length, 0);
assert.equal(maskSecret('short'), '***** (5)');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef'), 'sk-or********cdef (25)');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef').includes('0123456789'), false);
assert.match(validateSecret('ok\nNODE_OPTIONS=x'), /newline/);
assert.equal(validateSecret('sk-normal-key'), '');

// Salted scrypt storage: hash shape, round trip, wrong password, legacy
// plaintext comparison, and malformed hashes that must fail closed.
{
  const hashed = hashPassword('unit-test-pw');
  assert.equal(isPasswordHash(hashed), true);
  assert.equal(isPasswordHash('plain'), false);
  assert.equal(isPasswordHash(''), false);
  assert.equal(verifyPassword('unit-test-pw', hashed), true);
  assert.equal(verifyPassword('wrong', hashed), false);
  assert.equal(verifyPassword('plain', 'plain'), true);
  assert.equal(verifyPassword('other', 'plain'), false);
  assert.equal(verifyPassword('x', '$scrypt$broken'), false);
  assert.equal(verifyPassword('x', '$scrypt$N=16384$r=8$p=1$zz$zz'), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'));

  // The request path uses the thread-pool variants; they must agree with the
  // sync ones on every case, including the legacy plaintext fallback.
  const asyncHash = await hashPasswordAsync('unit-test-pw');
  assert.equal(isPasswordHash(asyncHash), true);
  assert.equal(await verifyPasswordAsync('unit-test-pw', asyncHash), true);
  assert.equal(await verifyPasswordAsync('wrong', asyncHash), false);
  assert.equal(await verifyPasswordAsync('unit-test-pw', hashed), true);
  assert.equal(await verifyPasswordAsync('plain', 'plain'), true);
  assert.equal(await verifyPasswordAsync('x', '$scrypt$broken'), false);
}

// Layered config: base defaults + sparse overlay, tombstones for deletions,
// additive-only schema migrations.
{
  const base = {
    host: '127.0.0.1',
    nested: { keep: 1, overrideMe: 'base' },
    list: ['a', 'b'],
    routes: { r1: ['x'], r2: ['y'] },
    providers: { p1: { baseUrl: 'https://a', freeModels: ['m'] } },
  };
  // Overlay wins per key; arrays replace wholesale; base-only branches are
  // cloned so mutating the live view never touches base objects.
  const merged = deepMerge(base, { nested: { overrideMe: 'user' }, list: ['c'] });
  assert.deepEqual(merged, {
    host: '127.0.0.1',
    nested: { keep: 1, overrideMe: 'user' },
    list: ['c'],
    routes: { r1: ['x'], r2: ['y'] },
    providers: { p1: { baseUrl: 'https://a', freeModels: ['m'] } },
  });
  merged.nested.keep = 99;
  merged.providers.p1.freeModels.push('zzz');
  assert.equal(base.nested.keep, 1);
  assert.deepEqual(base.providers.p1.freeModels, ['m']);
  // Tombstones keep operator deletions sticky across restarts.
  const live = buildLiveConfig(base, {
    routes: { r3: ['z'] },
    _removedRoutes: ['r1'],
    _removedProviders: ['p1'],
  });
  // Routes are no longer a feature, so buildLiveConfig ignores the old route
  // tombstone entirely; only provider tombstones are honoured.
  assert.deepEqual(Object.keys(live.routes).sort(), ['r1', 'r2', 'r3']);
  assert.deepEqual(live.providers, {});
  // Schema migrations only add missing skeleton keys, never overwrite.
  const overlay = { custom: 'mine', nested: { overrideMe: 'user' } };
  assert.equal(runOverlayMigrations(overlay), true);
  assert.equal(overlay._schemaVersion, SCHEMA_VERSION);
  assert.equal(
    runOverlayMigrations(overlay),
    false,
    'second run is a no-op',
  );
  const target = { a: 1, nested: { x: 1 } };
  assert.equal(addMissingKeys(target, { a: 2, b: 3, nested: { x: 2, y: 4 } }), true);
  assert.deepEqual(target, { a: 1, b: 3, nested: { x: 1, y: 4 } });
  assert.equal(addMissingKeys(target, { a: 1, b: 3, nested: { x: 1, y: 4 } }), false);
}

assert.equal(providerNeedsThoughtSignatures({ name: 'gemini', baseUrl: 'http://127.0.0.1' }), true);
assert.equal(
  providerNeedsThoughtSignatures({
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }),
  true,
);
assert.equal(providerNeedsThoughtSignatures({ name: 'bai', baseUrl: 'https://api.b.ai/v1' }), false);
assert.equal(
  isMissingThoughtSignatureError(
    400,
    'Function call is missing a thought_signature in functionCall parts',
  ),
  true,
);
assert.equal(isMissingThoughtSignatureError(400, 'bad request'), false);
assert.equal(isMissingThoughtSignatureError(429, 'thought_signature'), false);

{
  const cache = createThoughtSignatureCache(2);
  cache.remember('a', 'sig-a');
  cache.remember('b', 'sig-b');
  cache.remember('c', 'sig-c');
  assert.equal(cache.lookup('a'), '');
  assert.equal(cache.lookup('c'), 'sig-c');
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_keep',
            type: 'function',
            function: { name: 'search_files', arguments: '{}' },
            extra_content: { google: { thought_signature: 'KEEP' } },
          },
          {
            id: 'call_cached',
            type: 'function',
            function: { name: 'terminal', arguments: '{}' },
          },
          {
            id: 'call_skip',
            type: 'function',
            function: { name: 'other', arguments: '{}' },
          },
        ],
      },
    ],
  };
  cache.remember('call_cached', 'CACHED');
  injectThoughtSignatures(body, cache);
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[0]), 'KEEP');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[1]), 'CACHED');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[2]), SKIP_THOUGHT_SIGNATURE);
}

{
  const cache = createThoughtSignatureCache();
  rememberSignaturesFromPayload(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_json',
                extra_content: { google: { thoughtSignature: 'JSON-SIG' } },
              },
            ],
          },
        },
      ],
    },
    cache,
  );
  assert.equal(cache.lookup('call_json'), 'JSON-SIG');
  const streamCache = createThoughtSignatureCache();
  const extractor = createStreamSignatureExtractor((id, signature) => {
    streamCache.remember(id, signature);
  });
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_files","arguments":"{}"}}]}}]}\n',
  );
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"STREAM-SIG"}}}]}}]}\n\n',
  );
  extractor.flush();
  assert.equal(streamCache.lookup('call_1'), 'STREAM-SIG');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

let paidBrokeRequests = 0;
const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          'mock-a',
          'mock-b',
          'mock-new',
          'mock-audio',
          'acme/extra-1:free',
          'mock-domain',
          'deepseek-v3.2:free',
          'acme/paid-broke',
          'acme/paid-2',
        ].map((id) => ({
          id,
          description:
            id === 'mock-domain'
              ? 'A finance-focused mixture-of-experts model for investment research.'
              : 'A general purpose text model.',
          pricing:
            id === 'mock-b' || id.startsWith('acme/paid-')
              ? { prompt: '0.000001', completion: '0.000001' }
              : { prompt: '0', completion: '0' },
          supported_parameters: ['tools', 'response_format'],
          ...(id === 'deepseek-v3.2:free' ? { context_length: 8192 } : {}),
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
    if (body.model === 'acme/paid-broke') {
      paidBrokeRequests += 1;
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Insufficient credits on this account.' } }));
      return;
    }
    const isEvaluation = body.messages?.some(
      (message) => typeof message.content === 'string' && message.content.includes('OX-RANK-7'),
    );
    // This discovery-only model fails its evaluation on purpose, so the route
    // falls back to the published capability prior instead of a local score.
    if (isEvaluation && body.model === 'deepseek-v3.2:free') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: 'evaluation endpoint down' } }));
      return;
    }
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
                  derange: 44,
                  recur: 26,
                  modpow: 49,
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
let lastTokenRouterBody = null;
const tokenRouterMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    tokenRouterRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastTokenRouterBody = body;
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-token-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tokenrouter rate limited' } }));
      return;
    }
    const wantsTools = body.messages?.some((message) => message.content === 'responses-tools');
    if (wantsTools) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_r1',
                      type: 'function',
                      function: { name: 'lookup', arguments: '{"q":' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
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
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_r1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'token-' } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'router-ok' } }],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
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
let lastBaiBody = null;
let lastBaiAuth = '';
const baiMock = http.createServer(async (req, res) => {
  // A price-free catalog, in the shape Gemini's OpenAI-compat endpoint returns:
  // ids carry a "models/" prefix and glm-withdrawn is simply absent.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'models/glm-5.3-flash', object: 'model', owned_by: 'bai' },
          // Not in freeModels, so these four are probe candidates: one is
          // served, one has no free allowance, one bills the response, one is
          // not a chat model at all.
          { id: 'models/glm-5.3-pro', object: 'model', owned_by: 'bai' },
          { id: 'models/glm-5.3-paid', object: 'model', owned_by: 'bai' },
          { id: 'models/glm-5.3-billed', object: 'model', owned_by: 'bai' },
          {
            id: 'models/glm-5.3-embed',
            object: 'model',
            architecture: { output_modalities: ['embedding'] },
          },
        ],
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    baiRequests += 1;
    lastBaiAuth = req.headers.authorization || '';
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastBaiBody = body;
    // Probes address a model by the id the catalog published, prefix included.
    if (normalizeModelSlug(body.model) === 'glm-5.3-paid') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      // Wrapped in an array, the way Gemini's OpenAI-compatible layer returns
      // errors. Read as an object, `error.message` is missing and the whole
      // reason for the refusal is lost.
      res.end(JSON.stringify([quotaRejection(0)]));
      return;
    }
    // 200 with a positive bill: the catalog is not the last word on cost.
    if (normalizeModelSlug(body.model) === 'glm-5.3-billed') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000012 },
          choices: [
            { message: { role: 'assistant', content: 'billed-ok' }, finish_reason: 'stop' },
          ],
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [{ delta: { content: 'bai-ok' }, finish_reason: null }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
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
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let extraRequests = 0;
const extraMock = http.createServer(async (req, res) => {
  // A catalog that cannot be fetched must not empty the route: freeModels stays
  // authoritative and availability checking is simply skipped.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'catalog unavailable' } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    extraRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-extra-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'extra rate limited' } }));
      return;
    }
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

let geminiRequests = 0;
let lastGeminiBody = null;
const geminiMock = http.createServer(async (req, res) => {
  // Google's native listing, on its own URL and auth header. It carries sizes
  // but no creation timestamp, which is exactly the metadata /v1/models used
  // to drop on the floor for allowlisted models.
  if (req.method === 'GET' && req.url.split('?')[0] === '/v1beta/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-3.8-flash',
            displayName: 'Gemini 3.8 Flash',
            description: 'Fast general model.',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-3.7-flash',
            displayName: 'Gemini 3.7 Flash',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-embed-x',
            inputTokenLimit: 2048,
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1beta/openai/chat/completions') {
    geminiRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastGeminiBody = body;
    const forceMissing = body.messages?.some(
      (message) => message.content === 'force-thought-signature-400',
    );
    const missingSignature = (body.messages || []).some(
      (message) =>
        Array.isArray(message.tool_calls) &&
        message.tool_calls.some((call) => !readThoughtSignature(call)),
    );
    if (forceMissing || missingSignature) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            error: {
              code: 400,
              message:
                'Function call is missing a thought_signature in functionCall parts. https://ai.google.dev/gemini-api/docs/thought-signatures',
            },
          },
        ]),
      );
      return;
    }
    if (body.stream && body.messages?.some((message) => message.content === 'need-tools-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_stream',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    extra_content: { google: { thought_signature: 'STREAM-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.messages?.some((message) => message.content === 'need-tools-json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_json',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                    extra_content: { google: { thought_signature: 'JSON-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'gemini-ok' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// Mimics Gemini's quota rejection so the two meanings of 429 can be told apart
// end to end: no free allowance at all, versus today's allowance spent.
function quotaRejection(limit) {
  const metric = (suffix) => `generativelanguage.googleapis.com/generate_content_${suffix}`;
  const lines = [
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
  ].map((line) => `* Quota exceeded for metric: ${line}, model: mock`);
  return {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: `You exceeded your current quota.\n${lines.join('\n')}\nPlease retry in 42.5s.`,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            ['free_tier_requests', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'],
            ['free_tier_requests', 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerMinute-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerDay-FreeTier'],
          ].map(([suffix, quotaId]) => ({ quotaMetric: metric(suffix), quotaId })),
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' },
      ],
    },
  };
}

// A price-free catalog that insists on a bearer key, the way HashNeuron's
// listing does. The key lives in the overlay, so a listing request that sends
// only a base URL gets 401 no matter how well the provider is configured.
let keyedCatalogAuth = '';
const keyedMock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    keyedCatalogAuth = req.headers.authorization || '';
    if (keyedCatalogAuth !== 'Bearer keyed-secret') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'keyed-1', object: 'model', owned_by: 'keyed' }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let quotaRequests = 0;
const quotaMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    quotaRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quotaRejection(model === 'no-free-tier' ? 0 : 20)));
    return;
  }
  res.writeHead(404).end();
});

await listen(mock);
const mockPort = mock.address().port;
await listen(quotaMock);
const quotaPort = quotaMock.address().port;
await listen(tokenRouterMock);
const tokenRouterPort = tokenRouterMock.address().port;
await listen(baiMock);
const baiPort = baiMock.address().port;
await listen(extraMock);
const extraPort = extraMock.address().port;
await listen(keyedMock);
const keyedPort = keyedMock.address().port;
await listen(geminiMock);
const geminiPort = geminiMock.address().port;

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
    // Exploration would reorder requests nondeterministically; unit tests
    // in test-ranking.mjs cover the picker, live sampling stays manual.
    routing: { explorePercent: 0 },
    providers: {
      openrouter: {
        catalog: true,
        pricing: true,
        baseUrl: `http://127.0.0.1:${mockPort}/api/v1`,
        keyEnv: 'OPENROUTER_API_KEY',
        // Two paid models: one the operator selected (callable when named) and
        // one merely listed (404 unless it is selected).
        selectedModels: ['mock-b', 'acme/paid-broke'],
      },
      tokenrouter: {
        baseUrl: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
        keyEnv: 'TOKENROUTER_API_KEY',
        freeModels: ['z-ai/glm-5.3-free'],
      },
      bai: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: `http://127.0.0.1:${baiPort}/v1`,
        keyEnv: 'BAI_API_KEY',
        freeModels: ['glm-5.3-flash', 'glm-withdrawn'],
      },
      extra: {
        catalog: true,
        pricing: false,
        baseUrl: `http://127.0.0.1:${extraPort}/v1`,
        keyEnv: 'EXTRA_API_KEY',
        freeModels: ['extra-1'],
      },
      keyed: {
        catalog: true,
        pricing: false,
        baseUrl: `http://127.0.0.1:${keyedPort}/v1`,
        keyEnv: 'KEYED_API_KEY',
        freeModels: [],
      },
      gemini: {
        catalog: true,
        pricing: false,
        baseUrl: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
        modelsUrl: `http://127.0.0.1:${geminiPort}/v1beta/models`,
        modelsKeyHeader: 'x-goog-api-key',
        keyEnv: 'GEMINI_API_KEY',
        freeModels: ['gemini-3.8-flash', 'gemini-3.7-flash'],
      },
      // No dailyLimits entry anywhere in this config: the limit for
      // daily-exhausted has to be learned from the provider's own 429.
      quotamock: {
        baseUrl: `http://127.0.0.1:${quotaPort}/v1`,
        keyEnv: 'QUOTAMOCK_API_KEY',
        freeModels: ['no-free-tier', 'daily-exhausted'],
      },
    },
    discovery: {
      enabled: true,
      intervalMs: 604800000,
      stateFile: 'discovered-free-models.json',
      exclude: {
        textPatterns: ['\\b(finance|medicine)[\\s-]*focused\\b'],
      },
      evaluation: {
        enabled: true,
        pinnedModels: ['tokenrouter:z-ai/glm-5.3-free', 'bai:glm-5.3-flash'],
        baselineScores: { 'mock-b': 80 },
        usageWeight: 12,
        usageMinRequests: 2,
      },
    },
    cooldownMs: {},
    usage: {
      retentionDays: 3,
      timezone: 'UTC',
      dailyLimits: { 'bai:glm-5.3-flash': 5, 'tokenrouter:*': 50 },
    },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, '..', 'app', 'server.mjs')], {
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
    GEMINI_API_KEY: 'gemini-test-key',
    GEMINI_BASE_URL: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
    QUOTAMOCK_API_KEY: 'quota-test-key',
    QUOTAMOCK_BASE_URL: `http://127.0.0.1:${quotaPort}/v1`,
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
  let health = await waitForHealth();
  // Probing runs in the background by design, so the model pool fills in after
  // the discovery stamp. Wait for the probe result instead of assuming the
  // first health response already has it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const verdicts = health.discovery?.modelVerdicts || {};
    if (
      verdicts['bai:models/glm-5.3-pro'] &&
      verdicts['bai:models/glm-5.3-paid'] &&
      verdicts['bai:models/glm-5.3-billed']
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) => res.json());
  }
  assert.equal(health.version, PACKAGE_VERSION);
  assert.equal(health.defaultModel, 'free-best');

  // /healthz is the probe shape: nothing about keys, usage or the pool.
  const healthz = await fetch(`http://127.0.0.1:${routerPort}/healthz`);
  assert.equal(healthz.status, 200);
  assert.deepEqual(Object.keys(await healthz.json()).sort(), ['ok', 'service', 'version']);

  const freeKeys = health.pool.free.map((entry) => `${entry.provider}:${entry.id}`);
  const paidKeys = health.pool.paid.map((entry) => `${entry.provider}:${entry.id}`);
  const entryFor = (key) => health.pool.free.find((entry) => `${entry.provider}:${entry.id}` === key);

  // Free membership comes from the rules alone: catalog prices, provider
  // verdicts, and each provider's allowlist. No route list exists any more.
  assert.equal(freeKeys[0], 'tokenrouter:z-ai/glm-5.3-free', 'pinned models lead the pool');
  assert.equal(freeKeys[1], 'bai:glm-5.3-flash');
  for (const key of [
    'openrouter:mock-a',
    'openrouter:mock-new',
    'openrouter:acme/extra-1:free',
    'openrouter:deepseek-v3.2:free',
    'extra:extra-1',
    'gemini:gemini-3.8-flash',
    'gemini:gemini-3.7-flash',
    'quotamock:no-free-tier',
    'quotamock:daily-exhausted',
    'bai:models/glm-5.3-pro',
  ]) {
    assert.ok(freeKeys.includes(key), `free pool must contain ${key}`);
  }
  // Selected paid models live in their own view and are never automatic
  // fallback material. A paid model nobody selected is not even admitted.
  assert.deepEqual(paidKeys.sort(), ['openrouter:acme/paid-broke', 'openrouter:mock-b']);
  assert.equal(freeKeys.includes('openrouter:acme/paid-2'), false);

  const probeVerdicts = health.discovery.modelVerdicts;
  assert.equal(probeVerdicts['bai:models/glm-5.3-pro'].free, true);
  assert.match(probeVerdicts['bai:models/glm-5.3-pro'].reason, /served a free-tier request/);
  // Answered 429 with every free-tier limit at zero, so it never enters the pool.
  assert.equal(probeVerdicts['bai:models/glm-5.3-paid'].free, false);
  assert.equal(freeKeys.some((key) => key.includes('glm-5.3-paid')), false);
  // A 200 that reports a positive cost is paid, whatever the catalog said.
  assert.equal(probeVerdicts['bai:models/glm-5.3-billed'].free, false);
  assert.match(probeVerdicts['bai:models/glm-5.3-billed'].reason, /billing/);
  assert.equal(health.discovery.evaluations['glm-5.3-billed'], undefined);
  assert.equal(freeKeys.some((key) => key.includes('glm-5.3-billed')), false);
  // Not a chat model, so it was filtered out before any request was spent on it.
  assert.equal(probeVerdicts['bai:models/glm-5.3-embed'], undefined);
  // Already configured under a bare id, so the prefixed catalog entry for the
  // same model must not be probed again or admitted a second time.
  assert.equal(probeVerdicts['bai:models/glm-5.3-flash'], undefined);
  assert.equal(freeKeys.filter((key) => key.endsWith('glm-5.3-flash')).length, 1);
  // A domain-tuned model is free and chat-capable, but must not join the pool
  // or spend an evaluation on it.
  assert.deepEqual(health.discovery.excludedModels, ['openrouter:mock-domain']);
  assert.equal(health.discovery.evaluations['mock-domain'], undefined);
  assert.equal(freeKeys.includes('openrouter:mock-domain'), false);

  const mockNewEvaluation = health.discovery.evaluations['mock-new'];
  assert.equal(mockNewEvaluation.version, 2);
  assert.equal(mockNewEvaluation.benchmarkScore, 65);
  assert.equal(mockNewEvaluation.metadataScore, 12);
  assert.equal(mockNewEvaluation.latencyScore, 6);
  // A free catalog model with no hand-written anchor is ranked by its
  // evaluation, not by its position in a route.
  const mockAEntry = entryFor('openrouter:mock-a');
  assert.equal(mockAEntry.baseScore, 83);
  assert.equal(mockAEntry.score, 83);
  assert.equal(mockAEntry.scoreSource, 'evaluation');
  // Its evaluation failed, so ranking falls back to the shipped SWE-bench
  // prior instead of treating the model as unranked.
  const sweEntry = entryFor('openrouter:deepseek-v3.2:free');
  assert.equal(sweEntry.baseScore, 73.1);
  assert.equal(sweEntry.score, 73.1);
  assert.equal(sweEntry.scoreSource, 'swe-bench');
  assert.equal(entryFor('openrouter:mock-new').scoreSource, 'evaluation');
  assert.equal(mockNewEvaluation.score, 83);
  assert.equal(health.defaultProvider, 'openrouter');
  assert.equal(health.providers.openrouter.kind, 'catalog');
  assert.equal(health.providers.tokenrouter.kind, 'static');
  assert.equal(health.providers.extra.configured, true);

  // Priced catalogs and probeFreeTier catalogs both add models; a catalog that
  // neither prices nor probes only exists to notice withdrawals.
  assert.deepEqual(health.discovery.addsFrom, ['openrouter', 'bai']);
  assert.deepEqual(health.discovery.availabilityOnly, ['extra', 'keyed', 'gemini']);
  assert.equal(health.providers.bai.kind, 'static+catalog');

  // glm-5.3-flash is listed upstream as "models/glm-5.3-flash": a spelling
  // difference must not read as a withdrawal.
  assert.deepEqual(health.providers.bai.unavailableModels, ['glm-withdrawn']);
  assert.deepEqual(health.discovery.unavailableModels, ['bai:glm-withdrawn']);
  assert.equal(freeKeys.includes('bai:glm-withdrawn'), false);
  // An allowlisted model is free by configuration, so a catalog without prices
  // must not make it look paid.
  assert.equal(entryFor('bai:glm-5.3-flash').free, true);
  // extra's catalog request fails, which must leave its allowlist authoritative
  // instead of dropping the provider from the pool.
  assert.equal(health.providers.extra.kind, 'static+catalog');
  assert.deepEqual(health.providers.extra.unavailableModels, []);
  assert.ok(freeKeys.includes('extra:extra-1'));
  assert.ok(health.providers.extra.catalogError);
  // Priced catalog models never become removal news: they were never free.
  assert.deepEqual(health.discovery.removedModels, []);
  assert.equal(health.discovery.evaluations['mock-new'].status, 'scored');
  const persistedFree = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'discovered-free-models.json'), 'utf8'),
  );
  assert.ok(persistedFree.freeModels.includes('openrouter:mock-a'));
  assert.deepEqual(persistedFree.paymentBlocks, {});
  const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  // The alias leads, then the free pool in routing order, then the paid models
  // the operator selected. An excluded model is not advertised at all, and a
  // paid model nobody selected stays out too.
  assert.deepEqual(
    models.data.map((model) => model.id),
    [
      'free-best',
      'z-ai/glm-5.3-free',
      'glm-5.3-flash',
      'acme/extra-1:free',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'extra-1',
      'no-free-tier',
      'daily-exhausted',
      'mock-a',
      'mock-new',
      'deepseek-v3.2:free',
      'models/glm-5.3-pro',
      'mock-b',
      'acme/paid-broke',
    ],
  );
  // Every listed entry carries the standard OpenAI model fields plus whatever
  // the catalogs publish. Gemini's allowlist used to report zeroes for both
  // sizes; the catalog it already fetches has the real numbers.
  const modelsById = new Map(models.data.map((model) => [model.id, model]));
  const geminiListed = modelsById.get('gemini-3.8-flash');
  assert.equal(geminiListed.object, 'model');
  assert.equal(geminiListed.context_length, 1048576);
  assert.equal(geminiListed.max_output_tokens, 65536);
  assert.equal(geminiListed.description, 'Fast general model.');
  assert.equal(geminiListed.name, 'Gemini 3.8 Flash');
  assert.equal(geminiListed.provider, 'gemini');
  assert.equal(geminiListed.free, true);
  // The embedding endpoint entry is never offered as a chat model.
  assert.equal(modelsById.has('gemini-embed-x'), false);
  // A priced catalog keeps its published metadata and capability list.
  const freeCatalogEntry = modelsById.get('mock-a');
  assert.equal(freeCatalogEntry.context_length, 0);
  assert.deepEqual(freeCatalogEntry.supported_parameters, ['tools', 'response_format']);
  assert.deepEqual(freeCatalogEntry.input_modalities, ['text']);
  // The published window reaches the context filter: not just cosmetic.
  assert.equal(modelsById.get('deepseek-v3.2:free').context_length, 8192);
  // Input plus requested output exceeds the model's published window, so the
  // candidate is dropped before an upstream request is spent on it.
  const oversized = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v3.2:free',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 9000,
    }),
  });
  assert.equal(oversized.status, 503);
  assert.equal((await oversized.json()).error.type, 'no_compatible_free_model');

  // A paid model runs only when the request names it, and only when the
  // operator selected it.
  const paidNamed = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-b', messages: [{ role: 'user', content: 'paid' }] }),
  });
  assert.equal(paidNamed.status, 200);
  assert.equal(paidNamed.headers.get('x-free-router-provider'), 'openrouter');
  const unselectedPaid = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openrouter:acme/paid-2',
      messages: [{ role: 'user', content: 'not selected' }],
    }),
  });
  assert.equal(unselectedPaid.status, 404);
  assert.equal((await unselectedPaid.json()).error.type, 'model_not_enabled');
  const unknownModel = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(unknownModel.status, 404);
  assert.equal((await unknownModel.json()).error.type, 'model_not_found');

  // Insufficient funds parks only that provider:model for 24h. The second
  // call is answered locally, so the upstream sees the failure exactly once.
  const brokeFirst = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'acme/paid-broke', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(brokeFirst.status, 402);
  const brokeBody = await brokeFirst.json();
  assert.equal(brokeBody.error.type, 'insufficient_funds');
  assert.ok(Number(brokeFirst.headers.get('retry-after')) > 3600);
  const brokeSecond = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'acme/paid-broke', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(brokeSecond.status, 402);
  assert.equal(paidBrokeRequests, 1, 'a blocked paid model must not reach upstream again');
  const blockedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) => res.json());
  const blockUntil = Date.parse(blockedHealth.paymentBlocks['openrouter:acme/paid-broke']?.until);
  assert.ok(blockUntil > Date.now(), 'the block must be persisted with its expiry');
  const blockedEntry = blockedHealth.pool.paid.find((entry) => entry.id === 'acme/paid-broke');
  assert.ok(blockedEntry.blockedUntil, 'the paid view must show the block');
  // The free pool is untouched by a paid model's billing problem.
  assert.ok(blockedHealth.pool.free.some((entry) => entry.id === 'mock-a'));
  // No model at all: the alias means "best free model", and the pinned
  // tokenrouter model fails over to the next pinned one.
  const request = {
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
  // The gateway asks the provider for usage to fill its request log; that ask
  // is not the client's, so a client that did not request usage never sees the
  // numbers or a usage-only chunk.
  assert.doesNotMatch(stream, /"usage"/, 'usage stays internal unless the client asked');

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

  // /v1/responses is translated to chat for the upstream and back for the
  // client, so the same route, key, and quota machinery serves both dialects.
  const responsesJson = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'z-ai/glm-5.3-free',
      instructions: 'be terse',
      input: 'responses-tools',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look something up.',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        },
      ],
      tool_choice: 'auto',
    }),
  });
  assert.equal(responsesJson.status, 200);
  assert.equal(responsesJson.headers.get('x-free-router-provider'), 'tokenrouter');
  const responsesPayload = await responsesJson.json();
  assert.equal(responsesPayload.object, 'response');
  assert.equal(responsesPayload.status, 'completed');
  assert.equal(responsesPayload.model, 'z-ai/glm-5.3-free');
  assert.match(responsesPayload.id, /^resp_/);
  assert.deepEqual(responsesPayload.output.map((item) => item.type), ['function_call']);
  assert.equal(responsesPayload.output[0].call_id, 'call_r1');
  assert.equal(responsesPayload.output[0].name, 'lookup');
  assert.equal(responsesPayload.output[0].arguments, '{"q":"x"}');
  assert.equal(responsesPayload.output[0].status, 'completed');
  assert.deepEqual(responsesPayload.usage, {
    input_tokens: 11,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  });
  // The upstream saw a chat request: instructions folded into a system
  // message and the Responses tool flattened to the chat shape.
  assert.equal(lastTokenRouterBody.messages[0].role, 'system');
  assert.equal(lastTokenRouterBody.messages[0].content, 'be terse');
  assert.equal(lastTokenRouterBody.messages[1].content, 'responses-tools');
  assert.equal(lastTokenRouterBody.tools[0].function.name, 'lookup');
  assert.equal(lastTokenRouterBody.stream, false);

  const responsesStream = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'z-ai/glm-5.3-free',
      input: 'hello',
      stream: true,
    }),
  });
  assert.equal(responsesStream.status, 200);
  assert.equal(responsesStream.headers.get('x-free-router-provider'), 'tokenrouter');
  const responsesSse = await responsesStream.text();
  const eventNames = [...responsesSse.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  assert.equal(eventNames[0], 'response.created');
  assert.ok(eventNames.includes('response.output_text.delta'));
  assert.ok(eventNames.includes('response.output_text.done'));
  assert.equal(eventNames.at(-1), 'response.completed');
  // A chat client's terminator is still what an OpenAI SDK waits for.
  assert.match(responsesSse, /data: \[DONE\]/);
  const deltaText = [...responsesSse.matchAll(/^data: (.+)$/gm)]
    .map((match) => match[1])
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data))
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(deltaText, 'token-router-ok');
  const completedEvent = [...responsesSse.matchAll(/^data: (.+)$/gm)]
    .map((match) => match[1])
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data))
    .find((event) => event.type === 'response.completed');
  assert.equal(completedEvent.response.output[0].content[0].text, 'token-router-ok');
  assert.equal(completedEvent.response.usage.input_tokens, 11);
  // Sequence numbers drive client-side ordering; a gap or repeat breaks it.
  const waves = [...responsesSse.matchAll(/^data: (.+)$/gm)]
    .map((match) => match[1])
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data).sequence_number);
  assert.deepEqual(
    waves,
    Array.from({ length: waves.length }, (_, index) => index),
  );

  const responsesStreamTools = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'z-ai/glm-5.3-free',
      input: 'responses-tools',
      stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
    }),
  });
  assert.equal(responsesStreamTools.status, 200);
  const toolSse = await responsesStreamTools.text();
  assert.match(toolSse, /response\.function_call_arguments\.delta/);
  assert.match(toolSse, /"arguments":"\{\\"q\\":\\"x\\"\}"/);
  assert.match(toolSse, /response\.completed/);

  // Stateful features cannot be honoured by a stateless fan-out. Saying so is
  // better than accepting them and quietly returning something that ignores
  // the previous turn.
  const stateful = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'z-ai/glm-5.3-free', input: 'hi', store: true }),
  });
  assert.equal(stateful.status, 400);
  assert.match((await stateful.json()).error.message, /store is not supported/);

  const updatedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(updatedHealth.lastSelection.requested, 'z-ai/glm-5.3-free');
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

  const extraFailoverResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'force-extra-failure' }],
      }),
    },
  );
  assert.equal(extraFailoverResponse.status, 200);
  assert.equal(extraFailoverResponse.headers.get('x-free-router-provider'), 'openrouter');
  assert.equal(extraFailoverResponse.headers.get('x-free-router-model'), 'acme/extra-1:free');
  assert.equal(
    (await extraFailoverResponse.json()).choices[0].message.content,
    'router-ok',
  );

  const geminiSkipResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_unseen',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_unseen', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiSkipResponse.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), SKIP_THOUGHT_SIGNATURE);

  const geminiToolResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [{ role: 'user', content: 'need-tools-json' }],
    }),
  });
  assert.equal(geminiToolResponse.status, 200);
  const geminiTools = await geminiToolResponse.json();
  const jsonToolCall = geminiTools.choices[0].message.tool_calls[0];
  assert.equal(readThoughtSignature(jsonToolCall), 'JSON-SIG');
  const geminiReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-json' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: jsonToolCall.id,
              type: 'function',
              function: jsonToolCall.function,
            },
          ],
        },
        { role: 'tool', tool_call_id: jsonToolCall.id, content: 'found' },
      ],
    }),
  });
  assert.equal(geminiReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'JSON-SIG');

  const geminiStream = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      stream: true,
      messages: [{ role: 'user', content: 'need-tools-stream' }],
    }),
  });
  assert.equal(geminiStream.status, 200);
  assert.match(await geminiStream.text(), /call_stream/);
  const geminiStreamReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-stream' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_stream',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_stream', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiStreamReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'STREAM-SIG');

  const geminiBeforeSkip = geminiRequests;
  const geminiSkipProvider = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'force-thought-signature-400' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_force',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_force', content: 'found' },
      ],
    }),
  });
  // The provider rejected the request body (missing thought_signature), so
  // every failure is the caller's fault: answer 400 with the upstream reason
  // instead of claiming the pool is exhausted.
  assert.equal(geminiSkipProvider.status, 400);
  const geminiSkipBody = await geminiSkipProvider.json();
  assert.equal(geminiSkipBody.error.type, 'invalid_request_error');
  assert.equal(geminiSkipBody.error.failures.length, 1);
  assert.equal(geminiSkipBody.error.failures[0].kind, 'clientError');
  assert.match(geminiSkipBody.error.failures[0].reason, /thought_signature/);
  assert.equal(geminiRequests, geminiBeforeSkip + 1);

  // Both quota models are in the route and both answer 429, but the reasons
  // differ and so must the consequences.
  for (const model of ['no-free-tier', 'daily-exhausted']) {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `quotamock:${model}`,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 502);
  }

  const quotaHealth = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
  const verdicts = quotaHealth.discovery.modelVerdicts;

  // limit: 0 on every free-tier metric means waiting can never help, so the
  // model is dropped from the route rather than retried forever.
  assert.equal(verdicts['quotamock:no-free-tier'].free, false);
  assert.match(verdicts['quotamock:no-free-tier'].reason, /no free-tier allowance/);
  assert.equal(
    quotaHealth.pool.free.some((entry) => entry.id === 'no-free-tier'),
    false,
  );

  // A positive limit proves the opposite: the model is free, just spent. It
  // stays in the route and the reported number becomes the daily limit, even
  // though no dailyLimits entry exists for it in config.
  assert.equal(verdicts['quotamock:daily-exhausted'].free, true);
  assert.equal(verdicts['quotamock:daily-exhausted'].dailyRequestLimit, 20);
  const exhaustedEntry = quotaHealth.pool.free.find(
    (entry) => entry.id === 'daily-exhausted',
  );
  assert.equal(exhaustedEntry.usage.dailyLimit, 20);
  assert.equal(exhaustedEntry.usage.dailyLimitSource, 'provider');
  assert.equal(
    quotaHealth.usage.models.find((entry) => entry.key === 'quotamock:daily-exhausted')
      .dailyLimitSource,
    'provider',
  );
  // Exhausted for the day, so the wait runs to the quota reset rather than the
  // 42.5s the provider suggested for its per-minute window.
  assert.ok(exhaustedEntry.cooldownSeconds > 3600, `cooldown ${exhaustedEntry.cooldownSeconds}`);

  const leakResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [
          {
            role: 'user',
            content: 'here is bai-test-key in chat',
          },
          {
            role: 'tool',
            content: 'BAI_API_KEY=bai-test-key\nOPENROUTER_API_KEY=test-key',
          },
        ],
      }),
    },
  );
  assert.equal(leakResponse.status, 200);
  const leaked = JSON.stringify(lastBaiBody);
  assert.equal(leaked.includes('bai-test-key'), false);
  assert.equal(leaked.includes('test-key'), false);
  assert.match(leaked, /\[REDACTED\]/);

  assert.ok(tokenRouterRequests >= 3);
  assert.ok(baiRequests >= 3);

  const usageHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  const usage = usageHealth.usage;
  assert.equal(usage.timezone, 'UTC');
  assert.equal(usage.retentionDays, 3);
  assert.equal(usage.days.length, 3);
  const usageByKey = new Map(usage.models.map((entry) => [entry.key, entry]));
  assert.deepEqual(
    [...usageByKey.keys()].sort(),
    [
      'bai:glm-5.3-flash',
      // A probe spends a real request, so it is counted like any other.
      'bai:models/glm-5.3-billed',
      'bai:models/glm-5.3-paid',
      'bai:models/glm-5.3-pro',
      'extra:extra-1',
      'gemini:gemini-3.8-flash',
      'openrouter:acme/extra-1:free',
      'openrouter:acme/paid-broke',
      'openrouter:deepseek-v3.2:free',
      'openrouter:mock-a',
      'openrouter:mock-b',
      'openrouter:mock-new',
      'quotamock:daily-exhausted',
      'quotamock:no-free-tier',
      'tokenrouter:z-ai/glm-5.3-free',
    ],
  );
  // The discovery evaluation burns real quota, so it has to be counted too.
  assert.equal(usageByKey.get('openrouter:mock-new').ok, 1);
  assert.equal(usageByKey.get('openrouter:deepseek-v3.2:free').fail, 1);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').ok, 4);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').fail, 0);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').ok, 4);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').counts.rateLimit, 2);
  assert.equal(usageByKey.get('extra:extra-1').counts.rateLimit, 1);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').ok, 5);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').fail, 1);
  assert.equal(usageByKey.has('gemini:gemini-3.7-flash'), false);
  // Ten from routing (the alias pair, the direct calls, the failover, the
  // selected paid call and the redaction probe), four catalog/allowlist
  // evaluations, two served probes on bai (one free, one billed and therefore
  // not routed), five Gemini tool-call round trips, and three /v1/responses
  // round trips on tokenrouter.
  assert.equal(usage.days[0].ok, 21);
  assert.equal(usageByKey.get('bai:models/glm-5.3-billed').ok, 1);
  // Three routing failures, the two deliberate quota rejections, the probe
  // that found glm-5.3-paid has no free allowance, the purposefully failed
  // deepseek evaluation, one forced Gemini thought-signature 400, and the
  // paid model's 402.
  assert.equal(usage.days[0].fail, 9);
  assert.equal(usage.days[0].topModel.key, 'gemini:gemini-3.8-flash');

  // A daily limit only counts attempts the provider actually served, so the
  // two tokenrouter 429s stay out of the consumed total.
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimit, 5);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimitSource, 'config');
  assert.equal(usageByKey.get('bai:glm-5.3-flash').remainingToday, 1);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').dailyLimit, 50);
  // Three more served /v1/responses round trips spend three more of the 50.
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').remainingToday, 46);
  assert.equal(usageByKey.get('extra:extra-1').dailyLimit, null);
  assert.equal(usageByKey.get('extra:extra-1').remainingToday, null);
  // A 429 never reaches the model, so it does not burn today's consumed count.
  assert.equal(usageByKey.get('quotamock:no-free-tier').today.consumed, 0);

  const routeEntry = usageHealth.pool.free.find(
    (entry) => `${entry.provider}:${entry.id}` === 'bai:glm-5.3-flash',
  );
  assert.equal(routeEntry.usage.today.ok, 4);
  assert.equal(routeEntry.usage.remainingToday, 1);

  const routeByKey = new Map(
    usageHealth.pool.free.map((entry) => [`${entry.provider}:${entry.id}`, entry]),
  );
  // extra:extra-1 served 1 of 2 attempts, but the miss was a rateLimit
  // (capacity, not model quality), so the quality score stays put. Its anchor
  // is now its position in the allowlist, not a route row.
  const extraEntry = routeByKey.get('extra:extra-1');
  assert.equal(extraEntry.baseScore, 94);
  assert.equal(extraEntry.scoreAdjustment, 0);
  assert.equal(extraEntry.score, 94);
  assert.equal(extraEntry.scoreSource, 'baseline');
  assert.equal(routeByKey.get('openrouter:deepseek-v3.2:free').scoreSource, 'swe-bench');
  // Pinned models are exempt from reliability adjustment.
  assert.equal(routeByKey.get('bai:glm-5.3-flash').scoreAdjustment, 0);
  // Pinned sits above the 0-100 scale but stays finite (was +Infinity,
  // which serialized as null).
  assert.equal(routeByKey.get('bai:glm-5.3-flash').score, 150);
  // A group is ranked by its best provider: the sibling served both of its
  // attempts (the evaluation and the failover), so it earns the full bonus.
  assert.equal(routeByKey.get('openrouter:acme/extra-1:free').scoreAdjustment, 12);
  // Both quotamock models answered 429 earlier, yet only the one with no free
  // allowance is gone. The exhausted one is still a free model and comes back
  // when its quota resets, so it keeps its place.
  assert.deepEqual(
    usageHealth.pool.free.map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      // The thought-signature 400 is a client fault now, so it no longer
      // cools the model down or drags its score below the sibling.
      'gemini:gemini-3.8-flash',
      'openrouter:acme/extra-1:free',
      'gemini:gemini-3.7-flash',
      'extra:extra-1',
      'quotamock:daily-exhausted',
      'openrouter:mock-a',
      'openrouter:mock-new',
      'openrouter:deepseek-v3.2:free',
      'bai:models/glm-5.3-pro',
    ],
  );

  const statePath = path.join(tempDir, 'discovered-free-models.json');
  const today = new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (persisted.usage?.[today]?.['bai:glm-5.3-flash']?.ok === 4) break;
    if (attempt === 39) throw new Error('usage counters were never persisted');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const base = `http://127.0.0.1:${routerPort}`;
  const pageResponse = await fetch(`${base}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'none'/);
  // The favicon is an image the page itself declares, so `default-src 'none'`
  // blocks it unless img-src is granted explicitly: the browser never even
  // issues the request, and the tab shows no icon. Any same-origin image the
  // page adds has to keep working.
  assert.match(
    pageResponse.headers.get('content-security-policy'),
    /img-src 'self'/,
    'the page CSP must allow its own favicon, or the browser blocks it silently',
  );
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Provider keys/);
  assert.match(pageHtml, /Pool priority/);
  assert.doesNotMatch(pageHtml, /data-tab="routes"/);
  assert.doesNotMatch(pageHtml, /data-tab="quota"/);
  assert.match(pageHtml, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  // The icon belongs to the login screen, so it must load with no session, and
  // the page's own CSP forbids external assets — it has to come from here.
  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  const faviconBody = await favicon.text();
  assert.match(faviconBody, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(faviconBody, /viewBox="0 0 32 32"/);
  assert.equal(faviconBody.includes('<script'), false);
  // Pinned tab and home screen take their own formats, and both are also
  // requested without a session.
  const maskIcon = await fetch(`${base}/mask-icon.svg`);
  assert.equal(maskIcon.status, 200);
  assert.match(maskIcon.headers.get('content-type'), /image\/svg\+xml/);
  const maskBody = await maskIcon.text();
  assert.match(maskBody, /viewBox="0 0 16 16"/, 'Safari requires a 16x16 viewBox');
  assert.equal(maskBody.includes('<rect'), false, 'a background tile fills the pinned tab solid');
  const touchIcon = await fetch(`${base}/apple-touch-icon.png`);
  assert.equal(touchIcon.status, 200);
  assert.equal(touchIcon.headers.get('content-type'), 'image/png');
  const touchBody = Buffer.from(await touchIcon.arrayBuffer());
  assert.deepEqual([...touchBody.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'home-screen icon must be a PNG');
  assert.equal(pageHtml.includes('Today\'s quota'), false);
  // The page is a template string; an apostrophe in a JS string must not be
  // written as \', or the browser sees a truncated literal and the UI is blank.
  const pageScript = pageHtml.split('<script>')[1]?.split('</script>')[0];
  assert.ok(pageScript);
  new Function(pageScript);
  // The page script is embedded in a JS template literal: a single-backslash
  // regex like /\{(\w+)\}/ would be cooked into /{(w+)}/ and silently break
  // every {var} interpolation. Assert the served bytes kept the backslashes.
  assert.ok(pageHtml.includes('\\{(\\w+)\\}'));

  const uiState = await fetch(`${base}/api/state`).then((res) => res.json());
  assert.equal(uiState.error?.type, 'unauthorized');
  const unauthLogs = await fetch(`${base}/api/logs`);
  assert.equal(unauthLogs.status, 401, 'the request log needs the admin session');
  const unauthHealth = await fetch(`${base}/api/health`);
  assert.equal(unauthHealth.status, 401, 'the detailed health payload needs the admin session');
  const unauthClear = await fetch(`${base}/api/logs`, { method: 'DELETE' });
  assert.equal(unauthClear.status, 401, 'clearing the request log needs the admin session');
  // Web UI management APIs require the admin session (default password).
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' }),
  });
  assert.equal(loginResponse.status, 200);
  const sessionCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(sessionCookie, /fr_session=/);
  const badLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(badLogin.status, 401);
  const uiHeaders = {
    'Content-Type': 'application/json',
    Cookie: sessionCookie,
    'Sec-Fetch-Site': 'same-origin',
  };
  const authedState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) =>
    res.json(),
  );
  assert.equal(authedState.gateway.requireAuth, false);
  assert.deepEqual(authedState.gateway.keys, []);
  const uiProviders = new Map(authedState.providers.map((entry) => [entry.name, entry]));
  assert.equal(uiProviders.get('bai').configured, true);
  // Gemini is listed first when present; this test config has no gemini, so the
  // first row stays whoever was declared first.
  if (uiProviders.has('gemini')) assert.equal(authedState.providers[0].name, 'gemini');
  assert.equal(uiProviders.get('bai').keyEnv, 'BAI_API_KEY');
  // The real key must never leave the process, only a recognisable stub.
  assert.equal(uiProviders.get('bai').maskedKey.includes('bai-test-key'), false);
  assert.equal(JSON.stringify(authedState).includes('bai-test-key'), false);
  assert.ok(authedState.usage.models.length > 0);
  assert.ok(authedState.pool.free.length > 0);
  assert.equal(authedState.routes, undefined);
  assert.equal(authedState.allRoutes, undefined);

  // The interface warns about a rejection only when it contradicts config.json.
  // quotamock:no-free-tier was written into the route by hand, so its refusal is
  // worth surfacing; bai's glm-5.3-paid was merely a probe candidate, and
  // listing every one of those would bury the case that needs attention.
  assert.deepEqual(
    authedState.excludedByProvider.map((entry) => entry.key),
    ['quotamock:no-free-tier'],
  );
  assert.match(authedState.excludedByProvider[0].reason, /no free-tier allowance/);
  // Still recorded in full for diagnosis, just not shown as a warning.
  const fullVerdicts = await (await fetch(`${base}/health`)).json();
  assert.equal(fullVerdicts.discovery.modelVerdicts['bai:models/glm-5.3-paid'].free, false);

  // A browser request from another site must be rejected before it can write.
  const csrf = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(csrf.status, 403);
  // fetch() silently drops a Host override, so this one needs a raw request.
  const rebind = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: routerPort,
        path: '/api/state',
        method: 'GET',
        headers: { Host: 'evil.example.com' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebind, 403);
  const badOrigin = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(badOrigin.status, 403);

  // Only known providers, so the env file cannot gain arbitrary variables.
  const unknownProvider = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'NODE_OPTIONS', key: '--require /tmp/evil.js' }),
  });
  assert.equal(unknownProvider.status, 400);
  const newlineInjection = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: 'ok\nNODE_OPTIONS=--require /tmp/evil.js' }),
  });
  assert.equal(newlineInjection.status, 400);

  const envPath = path.join(tempDir, '.env');
  assert.equal(fs.existsSync(envPath), false);

  const saved = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: 'bai-rotated-key' }),
  });
  assert.equal(saved.status, 200);
  const envBody = fs.readFileSync(envPath, 'utf8');
  assert.equal(envBody, 'BAI_API_KEY=bai-rotated-key\n');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(process.env.NODE_OPTIONS, undefined);

  // The new key has to apply without a restart, and the redactor has to learn
  // it so it cannot leak back out through an upstream payload.
  const malformed = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  const probeResponse = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'echo bai-rotated-key please' }],
    }),
  });
  assert.equal(probeResponse.status, 200);
  const probeId = probeResponse.headers.get('x-free-router-request-id') || '';
  assert.match(probeId, /^req_[0-9a-f]{16}$/, 'responses carry the id used in the request log');
  assert.equal(lastBaiAuth, 'Bearer bai-rotated-key');
  assert.equal(JSON.stringify(lastBaiBody).includes('bai-rotated-key'), false);

  // One row per client request: the bad body is rejected with no attempts, and
  // the successful probe is the newest row, holding metadata only.
  const logsResponse = await fetch(`${base}/api/logs`, { headers: { Cookie: sessionCookie } });
  assert.equal(logsResponse.status, 200);
  assert.equal(logsResponse.headers.get('cache-control'), 'no-store');
  const logs = await logsResponse.json();
  assert.equal(logs.capacity, 500);
  assert.ok(Number.isFinite(Date.parse(logs.since)), 'since is a timestamp');
  assert.equal(logs.size, logs.entries.length);
  assert.ok(logs.entries.length >= 2, `expected at least 2 log rows, got ${logs.entries.length}`);
  assert.equal(logs.entries[0].id, probeId, 'newest first');
  const probeEntry = logs.entries[0];
  assert.equal(probeEntry.model, 'glm-5.3-flash');
  assert.equal(probeEntry.dialect, 'chat');
  assert.equal(probeEntry.outcome, 'ok');
  assert.equal(probeEntry.status, 200);
  assert.ok(probeEntry.attempts.some((attempt) => attempt.ok), 'the attempt summary includes the answer');
  assert.equal(probeEntry.finishReason, 'stop');
  assert.equal(probeEntry.toolCalls, 0);
  assert.ok(probeEntry.contentChars > 0, 'the answer volume is recorded, not the answer');
  assert.equal(typeof probeEntry.reasoningChars, 'number');
  assert.equal(probeEntry.inputTokens, 5, 'the provider usage block is recorded');
  assert.equal(probeEntry.outputTokens, 2);
  assert.ok(probeEntry.outputTps > 0, 'output speed comes from tokens over generation time');
  assert.ok(probeEntry.fields.includes('model'));
  assert.ok(probeEntry.fields.includes('messages'));
  const streamEntry = logs.entries.find(
    (entry) => entry.stream === true && entry.upstreamModel === 'glm-5.3-flash' && entry.outcome === 'ok',
  );
  assert.ok(streamEntry, 'the streamed request is in the log');
  assert.equal(streamEntry.inputTokens, 7, 'stream usage reaches the log');
  assert.equal(streamEntry.outputTokens, 3);
  assert.ok(streamEntry.outputTps > 0, 'a stream records its output speed');
  const rejectedEntry = logs.entries.find(
    (entry) => entry.outcome === 'rejected' && entry.status === 400 && entry.attempts.length === 0,
  );
  assert.ok(rejectedEntry, 'the malformed body is recorded as a rejection with no attempts');
  const logsJson = JSON.stringify(logs);
  assert.equal(logsJson.includes('echo bai-rotated-key'), false, 'no prompt content');
  assert.equal(logsJson.includes('bai-rotated-key'), false, 'no key value');
  assert.equal(logsJson.includes('BAI_API_KEY='), false, 'no env assignment');

  // Clear empties the in-memory list, and the next read proves it.
  const clearResponse = await fetch(`${base}/api/logs`, { method: 'DELETE', headers: { Cookie: sessionCookie } });
  assert.equal(clearResponse.status, 200);
  assert.equal(clearResponse.headers.get('cache-control'), 'no-store');
  const clearPayload = await clearResponse.json();
  assert.equal(clearPayload.ok, true);
  assert.equal(clearPayload.cleared, logs.entries.length);
  const afterLogsClear = await fetch(`${base}/api/logs`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(afterLogsClear.size, 0);
  assert.deepEqual(afterLogsClear.entries, []);
  assert.equal(afterLogsClear.capacity, 500);

  const cleared = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: '' }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(fs.readFileSync(envPath, 'utf8'), '');
  const afterClear = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(
    afterClear.providers.find((entry) => entry.name === 'bai').configured,
    false,
  );

  // Editable-config endpoints: limits, discovery, settings, providers. The
  // route endpoint is gone, not merely hidden.
  assert.ok(afterClear.editable);
  const routesGone = await fetch(`${base}/api/routes`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'save', route: 'smoke-tmp', models: ['mock-a'] }),
  });
  assert.equal(routesGone.status, 404);

  const setLimit = await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'set', key: 'smoke:model', limit: 7 }),
  });
  assert.equal(setLimit.status, 200);
  const withLimit = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(withLimit.editable.limits.find((entry) => entry.key === 'smoke:model')?.limit, 7);
  const delLimit = await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', key: 'smoke:model' }),
  });
  assert.equal(delLimit.status, 200);

  const discOff = await fetch(`${base}/api/discovery`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ enabled: false, evaluationEnabled: false, pin: 'smoke:pinned' }),
  });
  assert.equal(discOff.status, 200);
  const discState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(discState.editable.discovery.enabled, false);
  assert.equal(discState.editable.discovery.evaluationEnabled, false);
  assert.ok(discState.editable.discovery.pinnedModels.includes('smoke:pinned'));
  const discOn = await fetch(`${base}/api/discovery`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ enabled: true, evaluationEnabled: true, unpin: 'smoke:pinned' }),
  });
  assert.equal(discOn.status, 200);

  // Manual discovery bypasses the interval and starts in the background, then
  // stamps a fresh run so the UI can tell it happened.
  const beforeManual = await fetch(`${base}/health`).then((res) => res.json());
  const beforeStamp = Date.parse(beforeManual.discovery.lastCheckedAt);
  const discRun = await fetch(`${base}/api/discovery`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ runNow: true }),
  });
  assert.equal(discRun.status, 200);
  assert.ok((await discRun.json()).notes.includes('discovery started in the background'));
  let afterStamp = beforeStamp;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await fetch(`${base}/health`).then((res) => res.json());
    afterStamp = Date.parse(current.discovery.lastCheckedAt);
    if (afterStamp > beforeStamp) break;
  }
  assert.ok(afterStamp > beforeStamp, 'manual discovery must stamp a new run');

  const settings = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ attemptTimeoutMs: 6000, redactSecrets: true }),
  });
  assert.equal(settings.status, 200);
  const settingsState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(settingsState.editable.general.attemptTimeoutMs, 6000);

  // Timezone: an alias is canonicalised on save, and an unknown zone is refused
  // here rather than stored and only noticed in the log after a restart.
  // `/api/state` reports the zone in effect (this process started with UTC and a
  // change only applies after a restart), so the check reads the overlay.
  const overlayTz = () =>
    JSON.parse(fs.readFileSync(path.join(tempDir, 'config.local.json'), 'utf8')).usage?.timezone;
  const tzLower = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ timezone: 'asia/shanghai' }),
  });
  assert.equal(tzLower.status, 200);
  assert.ok((await tzLower.json()).notes.includes('timezone Asia/Shanghai saved; restart to take effect'));
  assert.equal(overlayTz(), 'Asia/Shanghai', 'alias must be stored canonical');
  const tzBad = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
  });
  assert.equal(tzBad.status, 400, 'unknown timezone must be refused');
  assert.equal(overlayTz(), 'Asia/Shanghai', 'a rejected save must not change the value');
  // Clearing is legal and means "this machine's dates".
  const tzClear = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ timezone: '' }),
  });
  assert.equal(tzClear.status, 200);
  assert.equal(overlayTz(), '');
  // Restore what the rest of the run expects.
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ timezone: 'UTC' }),
  });

  const addProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({
      action: 'create',
      name: 'smokeprov',
      baseUrl: 'http://127.0.0.1:1/v1',
      catalog: true,
      pricing: false,
      freeModels: ['smoke-1'],
      probeFreeTier: true,
    }),
  });
  assert.equal(addProv.status, 200);
  const providerFlags = async () =>
    (await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) =>
      res.json(),
    )).editable.providers.find((entry) => entry.name === 'smokeprov');
  assert.equal((await providerFlags()).probeFreeTier, true);
  const probeUpdate = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'update', name: 'smokeprov', probeFreeTier: false }),
  });
  assert.equal(probeUpdate.status, 200);
  assert.ok((await probeUpdate.json()).notes.includes('probeFreeTier updated'));
  // The probe flag applies to the live provider object, so no restart note and
  // no stale state.
  assert.equal((await providerFlags()).probeFreeTier, false);
  // Explicit selection is deduplicated, trimmed, and mirrored into state, so
  // the picker can show exactly what the operator enabled.
  const selectModels = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({
      action: 'update',
      name: 'smokeprov',
      selectedModels: ['smoke-paid', ' smoke-1 ', 'smoke-paid', ''],
    }),
  });
  assert.equal(selectModels.status, 200);
  assert.deepEqual((await providerFlags()).selectedModels, ['smoke-paid', 'smoke-1']);
  const dupProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'create', name: 'smokeprov', baseUrl: 'http://127.0.0.1:1/v1' }),
  });
  assert.equal(dupProv.status, 400);
  const delProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', name: 'smokeprov' }),
  });
  assert.equal(delProv.status, 200);
  const noDefDel = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', name: 'openrouter' }),
  });
  assert.equal(noDefDel.status, 400);
  // fetch-models lists a not-yet-registered catalog with free flags from
  // pricing (mock-b is priced, the rest are zero-cost).
  const fetched = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models', baseUrl: `http://127.0.0.1:${mockPort}/api/v1` }),
  });
  assert.equal(fetched.status, 200);
  const fetchedBody = await fetched.json();
  assert.ok(Array.isArray(fetchedBody.models) && fetchedBody.models.length > 0);
  const byId = new Map(fetchedBody.models.map((m) => [m.id, m]));
  assert.equal(byId.get('mock-a')?.free, true);
  assert.equal(byId.get('mock-a')?.paid, false);
  // Priced listings are labelled paid; a listing that publishes no prices is
  // unknown, which the UI must treat as billable until proven otherwise.
  assert.equal(byId.get('mock-b')?.free, false);
  assert.equal(byId.get('mock-b')?.paid, true);
  const fetchBad = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models', baseUrl: 'not-a-url' }),
  });
  assert.equal(fetchBad.status, 400);
  // The edit modal lists a registered provider's catalog without the operator
  // re-pasting a key: the key already stored for that provider is used.
  const keyedSet = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'keyed', name: 'key-1', key: 'keyed-secret' }),
  });
  assert.equal(keyedSet.status, 200);
  const keyedFetch = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models', provider: 'keyed' }),
  });
  assert.equal(keyedFetch.status, 200);
  const keyedBody = await keyedFetch.json();
  assert.deepEqual(keyedBody.models.map((m) => m.id), ['keyed-1']);
  assert.equal(keyedBody.models[0].unknown, true);
  assert.equal(keyedCatalogAuth, 'Bearer keyed-secret');
  // An explicit base URL still wins, so an edited-but-unsaved URL can be
  // tried before it is saved.
  const keyedFetchOverride = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models', provider: 'keyed', baseUrl: `http://127.0.0.1:${keyedPort}/v1` }),
  });
  assert.equal(keyedFetchOverride.status, 200);
  // A pasted key is tried first, but a rejected one falls back to the stored
  // keys instead of failing the whole listing.
  const keyedFetchWrong = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models', provider: 'keyed', key: 'wrong-key' }),
  });
  assert.equal(keyedFetchWrong.status, 200);
  // Without a provider name and without a URL there is nothing to fetch.
  const fetchNothing = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'fetch-models' }),
  });
  assert.equal(fetchNothing.status, 400);

  // Session TTL, free-model counts, env migration record, logout.
  const ttlBad = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ sessionTtlHours: -1 }),
  });
  assert.equal(ttlBad.status, 400);
  const ttlSet = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ sessionTtlHours: 48 }),
  });
  assert.equal(ttlSet.status, 200);
  const ttlState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(ttlState.webui.sessionTtlHours, 48);
  assert.ok(ttlState.webui.sessionExpiresAt);
  const ttlNever = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ sessionTtlHours: 0 }),
  });
  assert.equal(ttlNever.status, 200);

  const counts = new Map(ttlState.providers.map((entry) => [entry.name, entry]));
  assert.equal(counts.get('extra').modelCount, 1);
  assert.equal(counts.get('extra').freeCount, 1);
  assert.equal(counts.get('bai').modelCount, 2);
  // bai's key was cleared above, so withdrawals cannot be checked and every
  // allowlisted model counts as available.
  assert.equal(counts.get('bai').freeCount, 2);
  assert.deepEqual(ttlState.migration.providers, {});

  // Password change persists a salted hash (never plaintext); the old
  // password stops working and the new one issues a fresh session.
  // A one-character admin password is refused; the floor applies to every
  // password set through the UI.
  const shortPw = await fetch(`${base}/api/webui-password`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ password: 'short-pw' }),
  });
  assert.equal(shortPw.status, 400);
  assert.match((await shortPw.json()).error.message, /at least 12/);

  const pwChange = await fetch(`${base}/api/webui-password`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ password: 's3cret-newpw' }),
  });
  assert.equal(pwChange.status, 200);
  // The hash lands in the overlay file; the tracked base config is untouched.
  const overlayPath = path.join(tempDir, 'config.local.json');
  const persistedOverlay = fs.readFileSync(overlayPath, 'utf8');
  assert.match(persistedOverlay, /\$scrypt\$/);
  assert.equal(persistedOverlay.includes('s3cret-newpw'), false);
  const persistedBase = fs.readFileSync(testConfig, 'utf8');
  assert.equal(persistedBase.includes('$scrypt$'), false);
  assert.equal(persistedBase.includes('s3cret-newpw'), false);
  const staleLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' }),
  });
  assert.equal(staleLogin.status, 401);
  const freshLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 's3cret-newpw' }),
  });
  assert.equal(freshLogin.status, 200);
  const freshCookie = String(freshLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.match(freshCookie, /fr_session=/);
  const freshState = await fetch(`${base}/api/state`, { headers: { Cookie: freshCookie } }).then((res) =>
    res.json(),
  );
  assert.equal(freshState.webui.defaultPassword, false);
  // Explicit password changes are stamped (boot hashing and first-boot seeds
  // are not); the UI shows it next to the change control.
  assert.match(freshState.webui.passwordChangedAt || '', /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(freshState.webui.passwordChangedAt) <= Date.now());
  assert.match(fs.readFileSync(overlayPath, 'utf8'), /"passwordChangedAt": "\d{4}-\d{2}-\d{2}T/);

  const logout = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { Cookie: freshCookie },
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${base}/api/state`, { headers: { Cookie: freshCookie } });
  assert.equal(afterLogout.status, 401);

  // Gateway key policy: an expiry date and a per-day request quota are
  // enforced per key, counted in the persisted state, and reported by
  // /api/state. Both are optional and editing one takes effect at once.
  {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 's3cret-newpw' }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const policyHeaders = { 'Content-Type': 'application/json', Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' };
    const createKey = (body) =>
      fetch(`${base}/api/gateway-keys`, {
        method: 'POST',
        headers: policyHeaders,
        body: JSON.stringify(body),
      });

    const created = await createKey({ action: 'create', name: 'quota-test', dailyLimit: '1' });
    assert.equal(created.status, 200);
    const quotaKey = await created.json();
    assert.equal(quotaKey.entry.dailyLimit, 1);
    const bearer = { Authorization: `Bearer ${quotaKey.key}` };
    assert.equal((await fetch(`${base}/v1/models`, { headers: bearer })).status, 200);
    const overQuota = await fetch(`${base}/v1/models`, { headers: bearer });
    assert.equal(overQuota.status, 429);
    assert.ok(Number(overQuota.headers.get('retry-after')) > 0);
    assert.match((await overQuota.json()).error.message, /daily request limit/);

    const expiredCreate = await createKey({
      action: 'create',
      name: 'expired-test',
      expiresAt: '2020-01-01',
    });
    assert.equal(expiredCreate.status, 200);
    const expiredKey = await expiredCreate.json();
    const refused = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${expiredKey.key}` },
    });
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error.message, /expired/);

    const policyState = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } }).then((res) =>
      res.json(),
    );
    const listed = policyState.gateway.keys.find((entry) => entry.name === 'quota-test');
    assert.equal(listed.dailyLimit, 1);
    assert.equal(listed.usedToday, 1);
    const expiredListed = policyState.gateway.keys.find((entry) => entry.name === 'expired-test');
    assert.match(expiredListed.expiresAt, /^2020-01-01T/);

    // Raising the limit makes the key usable again; clearing it removes the
    // cap entirely.
    const raised = await createKey({ action: 'update', name: 'quota-test', dailyLimit: '5' });
    assert.equal(raised.status, 200);
    assert.equal((await fetch(`${base}/v1/models`, { headers: bearer })).status, 200);
    const cleared = await createKey({ action: 'update', name: 'quota-test', dailyLimit: '' });
    assert.equal((await cleared.json()).key.dailyLimit, null);

    // Invalid policy values are refused instead of stored.
    assert.equal((await createKey({ action: 'create', name: 'bad-limit', dailyLimit: '-2' })).status, 400);
    assert.equal((await createKey({ action: 'create', name: 'bad-date', expiresAt: 'soon' })).status, 400);
    assert.equal((await createKey({ action: 'update', name: 'nope', dailyLimit: '1' })).status, 404);

    for (const name of ['quota-test', 'expired-test']) {
      const removed = await createKey({ action: 'delete', name });
      assert.equal(removed.status, 200);
    }
  }

  // Restart must be last: the server exits and stops answering. Re-login
  // first since the password change above revoked all sessions.
  const relogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 's3cret-newpw' }),
  });
  assert.equal(relogin.status, 200);
  const restartCookie = String(relogin.headers.get('set-cookie') || '').split(';')[0];
  const restart = await fetch(`${base}/api/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: restartCookie },
  });
  assert.equal(restart.status, 200);
  assert.equal((await restart.json()).ok, true);
  let wentAway = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    } catch {
      wentAway = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(wentAway, true, 'server did not exit after /api/restart');

  console.log(
    'smoke test passed: pluggable providers, ranking, fallback, discovery, usage counters, and tracking work',
  );
} finally {
  child.kill('SIGTERM');
  // Wait for the router to exit so its shutdown state write cannot race the
  // temp directory cleanup.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await close(mock);
  await close(tokenRouterMock);
  await close(baiMock);
  await close(extraMock);
  await close(keyedMock);
  await close(quotaMock);
  await close(geminiMock);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
}

// A corrupt overlay must stop the boot instead of quietly starting from
// defaults (no keys, default admin password). The message has to name the
// file and the backup, and the process must exit non-zero before listening.
{
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-corrupt-'));
  const corruptConfig = path.join(corruptDir, 'config.json');
  fs.writeFileSync(corruptConfig, JSON.stringify({ port: 8799 }));
  fs.writeFileSync(path.join(corruptDir, 'config.local.json'), '{"gateway": {');
  const boot = spawnSync(process.execPath, [path.join(HERE, '..', 'app', 'server.mjs')], {
    env: { ...process.env, FREE_ROUTER_CONFIG: corruptConfig },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(boot.status, 1, 'a corrupt overlay must abort the boot');
  assert.match(boot.stderr, /cannot parse/);
  assert.match(boot.stderr, /config\.local\.json/);
  assert.match(boot.stderr, /\.bak/);
  // The broken file is left untouched for repair, not rewritten.
  assert.equal(fs.readFileSync(path.join(corruptDir, 'config.local.json'), 'utf8'), '{"gateway": {');
  fs.rmSync(corruptDir, { recursive: true, force: true });
}
