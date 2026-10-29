#!/usr/bin/env node
// Unit tests for the implicit model pool (app/pool.mjs): what is callable,
// free vs paid vs unknown, how a request resolves, ordering, and the 24h
// insufficient-funds block.
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_ALIAS,
  buildPool,
  isRetryableCooldown,
  orderCandidates,
  paymentBlockFor,
  priceClass,
  prunePaymentBlocks,
  resolvePoolRequest,
  sanitizePaymentBlocks,
  seedScore,
} from '../app/pool.mjs';

function model(id, prompt, completion, extra = {}) {
  const entry = { id, architecture: { output_modalities: ['text'] }, ...extra };
  if (prompt !== undefined) entry.pricing = { prompt: String(prompt), completion: String(completion) };
  return entry;
}

function provider(name, catalog, extra = {}) {
  return {
    name,
    catalog: new Map((catalog || []).map((entry) => [entry.id, entry])),
    catalogHasPricing: false,
    freeModels: new Set(),
    selectedModels: new Set(),
    hasKey: true,
    ...extra,
  };
}

// ---- price classification -------------------------------------------------
assert.equal(priceClass(model('a', 0, 0)), 'free');
assert.equal(priceClass(model('b', '0.000001', '0.000002')), 'paid');
assert.equal(priceClass(model('c')), 'unknown');
assert.equal(priceClass({ id: 'd', pricing: { prompt: '0' } }), 'unknown');
assert.equal(priceClass({ id: 'e', pricing: { prompt: '0', completion: '0.1' } }), 'paid');

assert.equal(seedScore(1), 94);
assert.equal(seedScore(2), 90);
assert.equal(seedScore(17), 30);
assert.equal(seedScore(40), 30);

// ---- priced catalog: prices decide ---------------------------------------
{
  const or = provider(
    'or',
    [
      model('free/one', 0, 0),
      model('paid/one', 1, 2),
      model('mystery/one'),
      model('image/one', 0, 0, { architecture: { output_modalities: ['image'] } }),
    ],
    { catalogHasPricing: true, freeModels: new Set(['paid/one']) },
  );
  const pool = buildPool({ providers: [or] });
  assert.deepEqual(pool.free.map((entry) => entry.key), ['or:free/one']);
  assert.deepEqual(pool.paid, [], 'a priced catalog ignores the freeModels allowlist');
  assert.equal(pool.free[0].source, 'auto');
  assert.equal(pool.free[0].seedIndex, null);
  assert.ok(pool.free[0].catalogModel);

  // Selecting a paid and an unknown model admits them, labelled honestly.
  or.selectedModels = new Set(['paid/one', 'mystery/one']);
  const selectedPool = buildPool({ providers: [or] });
  assert.deepEqual(selectedPool.free.map((entry) => entry.key), ['or:free/one']);
  const paidByKey = new Map(selectedPool.paid.map((entry) => [entry.key, entry]));
  assert.equal(paidByKey.get('or:paid/one').paid, true);
  assert.equal(paidByKey.get('or:paid/one').unknown, false);
  assert.equal(paidByKey.get('or:paid/one').seedIndex, 0);
  assert.equal(paidByKey.get('or:mystery/one').unknown, true);
  assert.equal(paidByKey.get('or:mystery/one').paid, true);
  assert.equal(paidByKey.has('or:image/one'), false, 'non-chat models stay out');
}

// ---- price-free provider: allowlist + verdicts ---------------------------
{
  const gem = provider('gem', [model('flash', undefined, undefined), model('pro', undefined, undefined)], {
    freeModels: new Set(['flash', 'gone']),
  });
  const verdicts = {};
  const base = buildPool({ providers: [gem], verdictFor: (key) => verdicts[key] || null });
  assert.deepEqual(base.free.map((entry) => entry.key), ['gem:flash']);
  assert.equal(base.free[0].source, 'allowlist');
  assert.equal(base.free[0].seedIndex, 0, 'list position seeds the score');
  assert.equal(base.paid.length, 0);

  // A probed model joins the free pool without touching the allowlist.
  verdicts['gem:pro'] = { free: true };
  const probed = buildPool({ providers: [gem], verdictFor: (key) => verdicts[key] || null });
  assert.deepEqual(probed.free.map((entry) => entry.key), ['gem:flash', 'gem:pro']);
  assert.equal(probed.free[1].source, 'auto');

  // A refusal removes an allowlisted model, but never an explicitly selected one.
  verdicts['gem:flash'] = { free: false, reason: 'limit 0' };
  const refused = buildPool({ providers: [gem], verdictFor: (key) => verdicts[key] || null });
  assert.equal(refused.free.some((entry) => entry.key === 'gem:flash'), false);
  gem.selectedModels = new Set(['flash']);
  const kept = buildPool({ providers: [gem], verdictFor: (key) => verdicts[key] || null });
  const flash = kept.paid.find((entry) => entry.key === 'gem:flash');
  assert.ok(flash, 'selection overrides a negative verdict');
  assert.equal(flash.paid, true);
  assert.equal(flash.unknown, false);
}

// ---- selection on a price-free provider without an allowlist -------------
{
  const bai = provider('bai', [model('flash'), model('paid-ish')], {
    freeModels: new Set(['flash']),
    selectedModels: new Set(['paid-ish']),
  });
  const pool = buildPool({ providers: [bai] });
  assert.deepEqual(pool.free.map((entry) => entry.key), ['bai:flash']);
  assert.deepEqual(pool.paid.map((entry) => entry.key), ['bai:paid-ish']);
  assert.equal(pool.paid[0].unknown, true, 'no price evidence means unknown, not free');
}

// ---- catalog presence and keys -------------------------------------------
{
  const gem = provider('gem', [model('flash')], { freeModels: new Set(['flash', 'gone']) });
  const noKey = { ...gem, hasKey: false };
  assert.deepEqual(buildPool({ providers: [noKey] }).free, []);
  assert.deepEqual(buildPool({ providers: [gem] }).free.map((entry) => entry.key), ['gem:flash']);
}

// ---- request resolution ---------------------------------------------------
{
  const pool = {
    free: [
      { provider: 'a', model: 'flash', key: 'a:flash', free: true, paid: false },
      { provider: 'b', model: 'models/flash', key: 'b:models/flash', free: true, paid: false },
    ],
    paid: [
      { provider: 'a', model: 'pro', key: 'a:pro', free: false, paid: true },
      { provider: 'a', model: 'flash-pro', key: 'a:flash-pro', free: false, paid: true },
    ],
  };
  const parsePrefixed = (text) => {
    const separator = text.indexOf(':');
    if (separator <= 0) return null;
    const name = text.slice(0, separator);
    if (name !== 'a' && name !== 'b') return null;
    return { provider: name, model: text.slice(separator + 1) };
  };
  const resolve = (requested) => resolvePoolRequest(requested, pool, { parsePrefixed });

  assert.deepEqual(resolve('').candidates, pool.free);
  assert.deepEqual(resolve(DEFAULT_MODEL_ALIAS).candidates, pool.free);
  assert.equal(resolve('').allowPaid, false);

  const named = resolve('a:pro');
  assert.equal(named.kind, 'named');
  assert.deepEqual(named.candidates.map((entry) => entry.key), ['a:pro']);
  assert.equal(named.allowPaid, true);

  assert.equal(resolve('a:not-selected').kind, 'not_enabled');
  assert.deepEqual(resolve('a:not-selected').candidates, []);

  const bare = resolve('flash');
  assert.deepEqual(bare.candidates.map((entry) => entry.key), ['a:flash', 'b:models/flash']);
  assert.equal(bare.allowPaid, false);

  // Free offerings come before the paid one, and the paid one is allowed.
  const mixed = resolve('flash-pro');
  assert.deepEqual(mixed.candidates.map((entry) => entry.key), ['a:flash-pro']);
  assert.equal(mixed.allowPaid, true);

  assert.equal(resolve('nope').kind, 'unknown');
}

// ---- ordering -------------------------------------------------------------
{
  const candidates = [
    { provider: 'a', model: 'one' },
    { provider: 'b', model: 'one' },
    { provider: 'a', model: 'two' },
    { provider: 'a', model: 'three' },
  ];
  const ranked = orderCandidates(candidates, {
    rankGroup: (group) => {
      if (group.members.some(({ candidate }) => candidate.model === 'one' && candidate.provider === 'b')) {
        return { pinned: true, score: 150, tie: 1 };
      }
      if (group.slug === 'two') return { pinned: false, score: 80, tie: group.firstIndex };
      if (group.slug === 'three') return { pinned: false, score: 80, tie: group.firstIndex };
      return { pinned: false, score: 40, tie: group.firstIndex };
    },
    scarcityFor: (group) => (group.slug === 'three' ? 200 : 5),
  });
  assert.deepEqual(ranked.map((entry) => `${entry.provider}:${entry.model}`), [
    'b:one',
    'a:three',
    'a:two',
    'a:one',
  ], 'pinned first, then scarcity inside the tie band');

  const withSiblings = orderCandidates([{ provider: 'a', model: 'one' }], {
    rankGroup: () => ({ pinned: false, score: 50, tie: 0 }),
    siblingsFor: (slug) => (slug === 'one' ? [{ provider: 'c', model: 'one' }] : []),
  });
  assert.deepEqual(withSiblings.map((entry) => `${entry.provider}:${entry.model}`), ['a:one', 'c:one']);

  const noSiblings = orderCandidates([{ provider: 'a', model: 'one' }], {
    rankGroup: () => ({ pinned: false, score: 50, tie: 0 }),
    siblingsFor: () => [{ provider: 'c', model: 'one' }],
    expandSiblings: false,
  });
  assert.deepEqual(noSiblings.map((entry) => `${entry.provider}:${entry.model}`), ['a:one']);
}

// ---- insufficient-funds blocks -------------------------------------------
{
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const blocks = {
    'a:pro': { until: '2026-10-29T12:00:00.000Z', reason: 'insufficient funds', observedAt: '2026-10-28T12:00:00.000Z' },
    'a:old': { until: '2026-10-28T11:00:00.000Z', reason: 'insufficient funds' },
  };
  assert.equal(paymentBlockFor(blocks, 'a:pro', now).until, Date.parse('2026-10-29T12:00:00.000Z'));
  assert.equal(paymentBlockFor(blocks, 'a:old', now), null);
  assert.equal(paymentBlockFor(blocks, 'a:missing', now), null);
  const pruned = prunePaymentBlocks(blocks, now);
  assert.equal(pruned.changed, true);
  assert.deepEqual(Object.keys(pruned.blocks), ['a:pro']);
  assert.equal(prunePaymentBlocks(pruned.blocks, now).changed, false);

  // observedAt defaults to "now", so compare its shape, not a second sample
  // that can land on the next millisecond.
  const sanitizedBlocks = sanitizePaymentBlocks({
    'a:pro': { until: '2026-10-29T12:00:00.000Z' },
    bad: { until: 'x' },
  });
  assert.deepEqual(Object.keys(sanitizedBlocks), ['a:pro']);
  assert.equal(sanitizedBlocks['a:pro'].until, '2026-10-29T12:00:00.000Z');
  assert.equal(sanitizedBlocks['a:pro'].reason, '');
  assert.ok(Number.isFinite(Date.parse(sanitizedBlocks['a:pro'].observedAt)));

  // The pool surfaces the block on the paid entry, and only there.
  const or = provider('a', [model('pro', 5, 5)], {
    catalogHasPricing: true,
    selectedModels: new Set(['pro']),
  });
  const pool = buildPool({ providers: [or], paymentBlocks: blocks, now });
  assert.equal(pool.paid[0].blockedUntil, '2026-10-29T12:00:00.000Z');

  assert.equal(isRetryableCooldown('rateLimit'), true);
  assert.equal(isRetryableCooldown('overloaded'), true);
  assert.equal(isRetryableCooldown('payment'), false);
  assert.equal(isRetryableCooldown('notFound'), false);
  assert.equal(isRetryableCooldown('forbidden'), false);
}

console.log('pool unit tests passed');
