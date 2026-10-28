#!/usr/bin/env node
// Unit tests for provider quota/billing refusals (app/quota.mjs). The
// insufficient-funds predicate decides when a paid model is parked for 24h,
// so false positives are expensive in both directions.
import assert from 'node:assert/strict';

import {
  isInsufficientFunds,
  msUntilQuotaReset,
  parseQuotaFailure,
  permanentRejection,
} from '../app/quota.mjs';

// 402 is the unambiguous billing answer.
assert.equal(isInsufficientFunds(402, null), true);
assert.equal(isInsufficientFunds(402, { error: { message: 'whatever' } }), true);

// Gateways that answer 400/403 with a balance message count too.
assert.equal(isInsufficientFunds(400, { error: { message: 'Insufficient credits' } }), true);
assert.equal(isInsufficientFunds(403, { error: { code: 'insufficient_quota' } }), true);
assert.equal(isInsufficientFunds(400, { error: { message: 'Your balance is too low' } }), true);
assert.equal(isInsufficientFunds(403, { error: { message: 'check your plan and billing details' } }), true);
assert.equal(isInsufficientFunds(400, null, 'not enough credits for this request'), true);

// Free-tier exhaustion is not a billing fault and must never park a model.
assert.equal(isInsufficientFunds(429, { error: { message: 'insufficient credits' } }), false);
assert.equal(isInsufficientFunds(429, { error: { message: 'rate limit' } }), false);
// Path refusals keep their permanent-rejection meaning.
assert.equal(
  isInsufficientFunds(400, { error: { message: 'This model only supports the Interactions API' } }),
  false,
);
assert.equal(isInsufficientFunds(500, { error: { message: 'insufficient credits' } }), false);
assert.equal(isInsufficientFunds(404, { error: { message: 'model not found' } }), false);
assert.equal(isInsufficientFunds(400, { error: { message: 'bad request' } }), false);

// Existing quota parsing stays intact.
const gemini = {
  error: {
    message:
      'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
    ],
  },
};
const parsed = parseQuotaFailure(gemini);
assert.equal(parsed.noFreeTier, false);
assert.equal(parsed.dailyRequestLimit, 20);
assert.equal(parsed.exhaustedWindow, 'day');
assert.equal(parsed.retryDelayMs, 7000);
assert.equal(parseQuotaFailure({ error: { message: 'nope' } }), null);

const zero = {
  error: {
    message: 'Quota exceeded for metric: free_tier_requests, limit: 0',
    details: [],
  },
};
assert.equal(parseQuotaFailure(zero).noFreeTier, true);

assert.equal(permanentRejection(404, { error: { message: 'model is no longer available' } }), 'withdrawn upstream');
assert.equal(permanentRejection(404, { error: { message: 'not found' } }), 'listed in the catalog but not served here');
assert.equal(
  permanentRejection(400, { error: { message: 'This model only supports the Interactions API' } }),
  'not a chat-completions model',
);
assert.equal(permanentRejection(400, { error: { message: 'bad' } }), '');

const wait = msUntilQuotaReset(Date.parse('2026-10-28T10:00:00.000Z'), 'America/Los_Angeles');
assert.ok(wait > 0 && wait <= 86400000 + 60000);

console.log('quota unit tests passed');
