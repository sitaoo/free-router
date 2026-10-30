#!/usr/bin/env node
// Unit tests for gateway client key policy (app/gateway-keys.mjs): expiry,
// per-day request quotas, the retry hint that points at the next local
// midnight, and the persisted usage map.
import assert from 'node:assert/strict';

import {
  gatewayKeyState,
  gatewayUsageFor,
  msUntilNextDay,
  parseDailyLimit,
  parseExpiry,
  recordGatewayUse,
  sanitizeGatewayUsage,
} from '../app/gateway-keys.mjs';

const HOUR = 3600000;
const DAY = 86400000;

// Parsing what the UI sends.
assert.equal(parseDailyLimit(''), 0);
assert.equal(parseDailyLimit(undefined), 0);
assert.equal(parseDailyLimit('5'), 5);
assert.equal(parseDailyLimit(' 12 '), 12);
assert.equal(parseDailyLimit('3.9'), 3);
assert.equal(parseDailyLimit('0'), 0);
assert.equal(parseDailyLimit('-1'), null);
assert.equal(parseDailyLimit('abc'), null);
assert.equal(parseDailyLimit('1000001'), null);
assert.equal(parseExpiry(''), '');
assert.equal(parseExpiry(undefined), '');
assert.equal(parseExpiry('2026-12-31'), '2026-12-31T23:59:59.999Z');
assert.equal(parseExpiry('2026-12-31T10:00:00Z'), '2026-12-31T10:00:00.000Z');
assert.equal(parseExpiry('nonsense'), null);

// No policy: allowed, nothing left to report.
{
  const state = gatewayKeyState({ name: 'a' }, { now: 1_000_000, used: 9 });
  assert.equal(state.ok, true);
  assert.equal(state.status, 200);
  assert.equal(state.remaining, null);
}

// Expiry is inclusive of the instant: at or after it the key is dead.
{
  const now = Date.parse('2026-06-01T00:00:00Z');
  const entry = { name: 'a', expiresAt: '2026-06-02T00:00:00Z' };
  assert.equal(gatewayKeyState(entry, { now, used: 0 }).ok, true);
  const expired = gatewayKeyState(entry, { now: Date.parse('2026-06-02T00:00:00Z'), used: 0 });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 401);
  assert.equal(expired.reason, 'expired');
  assert.match(expired.message, /expired/);
}

// An unparseable expiry is ignored rather than locking the operator out.
{
  const state = gatewayKeyState({ name: 'a', expiresAt: 'nonsense' }, { now: 1, used: 0 });
  assert.equal(state.ok, true);
}

// Daily quota: under the limit is fine and reports what is left; at the
// limit it refuses with 429 and a retry hint bounded by the next local day.
{
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const entry = { name: 'a', dailyLimit: 3 };
  const first = gatewayKeyState(entry, { now, used: 0, timeZone: 'UTC' });
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 3);
  const last = gatewayKeyState(entry, { now, used: 2, timeZone: 'UTC' });
  assert.equal(last.ok, true);
  assert.equal(last.remaining, 1);
  const over = gatewayKeyState(entry, { now, used: 3, timeZone: 'UTC' });
  assert.equal(over.ok, false);
  assert.equal(over.status, 429);
  assert.equal(over.reason, 'quota');
  assert.equal(over.retryAfterMs, 12 * HOUR);
}

// The retry hint follows the configured zone's midnight, not UTC's.
{
  // 2026-01-01T16:00:00Z is exactly 2026-01-02T00:00 in Shanghai.
  const now = Date.UTC(2026, 0, 1, 16, 0, 0);
  assert.equal(msUntilNextDay(now, 'UTC'), 8 * HOUR);
  assert.equal(msUntilNextDay(now, 'Asia/Shanghai'), DAY);
  assert.equal(msUntilNextDay(now + 1000, 'UTC'), 8 * HOUR - 1000);
}

// Usage map: per key per day, pruned to the kept days, safe against junk.
{
  const usage = {};
  assert.equal(gatewayUsageFor(usage, 'laptop', '2026-01-01'), 0);
  recordGatewayUse(usage, 'laptop', '2026-01-01', 2);
  recordGatewayUse(usage, 'laptop', '2026-01-01', 2);
  assert.equal(gatewayUsageFor(usage, 'laptop', '2026-01-01'), 2);
  assert.equal(gatewayUsageFor(usage, 'other', '2026-01-01'), 0);

  const sanitized = sanitizeGatewayUsage(
    {
      laptop: { '2026-01-01': 4, '2026-01-02': -1, bogus: 3 },
      '': { '2026-01-01': 9 },
      broken: 'nope',
    },
    ['2026-01-01', '2026-01-02'],
  );
  assert.deepEqual(sanitized, { laptop: { '2026-01-01': 4 } });
}

// A day outside the kept window is dropped on the next write.
{
  const usage = { laptop: { '2025-12-01': 5 } };
  recordGatewayUse(usage, 'laptop', '2026-01-01', 1);
  assert.deepEqual(usage.laptop, { '2026-01-01': 1 });
}

console.log('gateway key unit tests passed');
