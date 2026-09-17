#!/usr/bin/env node
// Unit tests for external-score plumbing (app/scores.mjs): band
// normalization, name mapping, baseline merge policy, catalog summary.
import assert from 'node:assert/strict';

import {
  mapModelKey,
  mergeBaselineScores,
  normalizeBand,
  normalizeModelName,
  summarizeCatalog,
} from '../app/scores.mjs';

// Linear map into the prior band (below config anchors, above unevaluated).
assert.equal(normalizeBand(0, 0, 100), 40);
assert.equal(normalizeBand(100, 0, 100), 80);
assert.equal(normalizeBand(50, 0, 100), 60);
assert.equal(normalizeBand(200, 0, 100), 80);
assert.equal(normalizeBand(-10, 0, 100), 40);
assert.equal(normalizeBand(5, 5, 5), 60);
assert.equal(normalizeBand(1, 0, 3), 53.3);

// Name normalization is case/separator-insensitive.
assert.equal(normalizeModelName('  Google/Gemini-3.8 Flash '), 'googlegemini38flash');
assert.equal(normalizeModelName('z-ai/glm-5.3-free'), 'zaiglm53free');

// Alias table first, then normalized slug; unknown maps to null (skipped
// with a report line, never guessed).
{
  const aliases = { gemini38flash: 'gemini-3.8-flash' };
  assert.equal(mapModelKey('Gemini 3.8 Flash', aliases), 'gemini-3.8-flash');
  assert.equal(mapModelKey('Some Unknown Model 9', aliases), null);
  assert.equal(mapModelKey('', aliases), null);
}

// Merge policy: fetched wins on conflict (refresh beats stale), manual-only
// keys are never deleted.
{
  const merged = mergeBaselineScores({ a: 1, c: 9 }, { a: 2, b: 3 });
  assert.deepEqual(merged.merged, { a: 2, b: 3, c: 9 });
  assert.deepEqual(merged.added, ['b']);
  assert.deepEqual(merged.updated, ['a']);
  assert.deepEqual(merged.kept, ['c']);
}
{
  const merged = mergeBaselineScores({}, {});
  assert.deepEqual(merged.merged, {});
  assert.deepEqual(merged.added, []);
}

// Catalog summary: zero-price or :free suffix counts as free.
{
  const summary = summarizeCatalog([
    { id: 'a:free', pricing: { prompt: '1', completion: '1' } },
    { id: 'b', pricing: { prompt: '0', completion: '0' } },
    { id: 'c', pricing: { prompt: '0.5', completion: '0.5' } },
    { id: 'd' },
  ]);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.free.sort(), ['a:free', 'b']);
  assert.deepEqual(summary.priced, ['c']);
  assert.deepEqual(summary.unknown, ['d']);
}

console.log('scores unit tests passed');
