#!/usr/bin/env node
// SWE-bench lookup: exact ids, provider prefixes, :free suffixes, and the
// spelling variants a free catalog actually publishes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSweBenchScores, sweBenchScoreFor, toSweSlugKey } from '../app/swe-bench.mjs';

assert.equal(toSweSlugKey('deepseek-v3.2:free'), 'deepseek');
assert.equal(toSweSlugKey('meta-llama/llama-3.3-70b-instruct:free'), 'llama-3-3-70b');
assert.equal(toSweSlugKey('gemini-3.8-flash'), 'gemini-3-8-flash');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-swe-'));
try {
  const file = path.join(dir, 'swe.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      scores: {
        'deepseek-v3.2': 73.1,
        'llama-3.3-70b-instruct': 39.5,
        'glm5': 77.8,
      },
      models: [{ model_id: 'vendor/nex-n2.5-pro', swe_bench: '80.8%' }],
    }),
  );
  const scores = loadSweBenchScores(file);
  assert.equal(sweBenchScoreFor(scores, 'openrouter:deepseek-v3.2:free'), 73.1);
  assert.equal(sweBenchScoreFor(scores, 'deepseek-v3.2'), 73.1);
  assert.equal(sweBenchScoreFor(scores, 'meta-llama/llama-3.3-70b-instruct:free'), 39.5);
  // Prefix match handles the compact spelling GLM uses upstream.
  assert.equal(sweBenchScoreFor(scores, 'glm-5.2'), 77.8);
  assert.equal(sweBenchScoreFor(scores, 'nex-n2.5-pro'), 80.8);
  assert.equal(sweBenchScoreFor(scores, 'unknown-model'), null);

  // Missing or malformed files are an empty map, never a crash.
  assert.equal(loadSweBenchScores(path.join(dir, 'missing.json')).size, 0);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.equal(loadSweBenchScores(path.join(dir, 'bad.json')).size, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The shipped table must load and cover the models the default route uses.
const shipped = loadSweBenchScores(
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'app', 'data', 'swe-bench.json'),
);
assert.ok(shipped.size > 30, 'shipped SWE table is missing');
assert.ok(Number.isFinite(sweBenchScoreFor(shipped, 'gemini-3.8-flash')), 'gemini 3.8 flash missing');
assert.ok(Number.isFinite(sweBenchScoreFor(shipped, 'deepseek-v3.2')), 'deepseek v3.2 missing');

console.log('swe-bench unit tests passed');
