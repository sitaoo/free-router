#!/usr/bin/env node
// Unit tests for ranking signal hygiene (app/ranking.mjs):
// capacity failures must not pollute the quality score, and routing
// faults must never be scored as model quality.
import assert from 'node:assert/strict';

import {
  CAPACITY_FAIL_KINDS,
  QUALITY_FAIL_KINDS,
  UNATTRIBUTED_FAIL_KINDS,
  USAGE_KINDS,
  classifyFailure,
  isCredentialFault,
  metadataBonus,
  metadataScore,
  qualityTotals,
} from '../app/ranking.mjs';

// Capacity failures (rate limit / timeout / aborted client) describe the
// serving conditions, not the model. They must not move the quality score.
assert.deepEqual(
  qualityTotals({ ok: 10, rateLimit: 5, timeout: 3, aborted: 2 }),
  { ok: 10, fail: 0 },
);

// Quality failures (empty or broken responses, upstream errors, unknowns)
// are the model's own record and must keep counting.
assert.deepEqual(
  qualityTotals({ ok: 10, empty: 2, serverError: 1, other: 1 }),
  { ok: 10, fail: 4 },
);

// Routing faults (wrong model id, no access) are config/credential faults,
// recorded elsewhere but never scored as model quality.
assert.deepEqual(
  qualityTotals({ ok: 10, notFound: 4, forbidden: 2 }),
  { ok: 10, fail: 0 },
);

// Empty or missing input is zero, not an error.
assert.deepEqual(qualityTotals({}), { ok: 0, fail: 0 });
assert.deepEqual(qualityTotals(undefined), { ok: 0, fail: 0 });

// The kind set documents the contract: quality failures only.
assert.ok(QUALITY_FAIL_KINDS.has('empty'));
assert.ok(QUALITY_FAIL_KINDS.has('serverError'));
assert.ok(QUALITY_FAIL_KINDS.has('other'));
assert.ok(!QUALITY_FAIL_KINDS.has('rateLimit'));
assert.ok(!QUALITY_FAIL_KINDS.has('timeout'));
assert.ok(!QUALITY_FAIL_KINDS.has('aborted'));
assert.ok(!QUALITY_FAIL_KINDS.has('notFound'));
assert.ok(!QUALITY_FAIL_KINDS.has('forbidden'));
assert.ok(!QUALITY_FAIL_KINDS.has('ok'));

// A 401 is a credential fault (bad key), never a model fault. Call sites
// must skip recordUsage for it, otherwise it lands in the 'other' bucket
// and pollutes the quality score.
assert.equal(isCredentialFault(401), true);
assert.equal(isCredentialFault(429), false);
assert.equal(isCredentialFault(500), false);
assert.equal(isCredentialFault(undefined), false);

// Failure classification: every known kind lands in exactly one bucket,
// so a new status can never silently pollute the quality score again
// (the 401-in-'other' bug that motivated this).
{
  const bucketed = new Set([
    ...QUALITY_FAIL_KINDS,
    ...CAPACITY_FAIL_KINDS,
    ...UNATTRIBUTED_FAIL_KINDS,
  ]);
  for (const kind of USAGE_KINDS) {
    if (kind === 'ok') continue;
    assert.ok(bucketed.has(kind), `${kind} is not bucketed`);
  }
  assert.equal(
    QUALITY_FAIL_KINDS.size + CAPACITY_FAIL_KINDS.size + UNATTRIBUTED_FAIL_KINDS.size,
    bucketed.size,
    'buckets must not overlap',
  );
}

// Existing mapping is preserved.
assert.equal(classifyFailure(0, 'boom', true), 'timeout');
assert.equal(classifyFailure(429, '', false), 'rateLimit');
assert.equal(classifyFailure(404, '', false), 'notFound');
assert.equal(classifyFailure(403, '', false), 'forbidden');
assert.equal(classifyFailure(500, '', false), 'serverError');
assert.equal(classifyFailure(200, 'empty response', false), 'empty');
assert.equal(classifyFailure(200, 'all good', false), '');
// Payment and overload get their own kinds instead of hiding in 'other'.
assert.equal(classifyFailure(402, '', false), 'payment');
assert.equal(classifyFailure(529, '', false), 'overloaded');
assert.equal(classifyFailure(503, 'server overloaded, retry later', false), 'overloaded');
assert.equal(classifyFailure(503, 'internal error', false), 'serverError');
// New kinds never score as quality.
assert.deepEqual(qualityTotals({ ok: 5, payment: 3, overloaded: 2 }), { ok: 5, fail: 0 });

// Capability portrait (moved verbatim from server.mjs; behavior pinned).
assert.equal(metadataScore(null), 2);
assert.equal(metadataScore({}), 2);
assert.equal(
  metadataScore({
    supported_parameters: ['tools', 'response_format'],
    context_length: 131072,
    architecture: { input_modalities: ['text'] },
    created: 1000000000,
  }),
  17,
);
assert.equal(
  metadataScore({
    supported_parameters: ['structured_outputs'],
    context_length: 1048576,
    architecture: { input_modalities: ['image'] },
    created: Math.floor(Date.now() / 1000) - 100,
  }),
  12,
);

// Configured-position scores blend in a capped capability-portrait bonus,
// so a strong model placed low is not stuck behind a weak model placed high.
// The +2 text-modality floor means "no information" and earns no bonus.
assert.equal(metadataBonus(null), 0);
assert.equal(metadataBonus(undefined), 0);
assert.equal(metadataBonus({}), 0);
assert.equal(
  metadataBonus({
    supported_parameters: ['tools', 'response_format'],
    context_length: 131072,
    architecture: { input_modalities: ['text'] },
    created: 1000000000,
  }),
  8,
);
assert.equal(metadataBonus({ supported_parameters: ['tools'] }), 8);

console.log('ranking unit tests passed');
