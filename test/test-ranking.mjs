#!/usr/bin/env node
// Unit tests for ranking signal hygiene (app/ranking.mjs):
// capacity failures must not pollute the quality score, and routing
// faults must never be scored as model quality.
import assert from 'node:assert/strict';

import { QUALITY_FAIL_KINDS, isCredentialFault, qualityTotals } from '../app/ranking.mjs';

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

console.log('ranking unit tests passed');
