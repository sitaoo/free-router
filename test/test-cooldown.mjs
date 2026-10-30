#!/usr/bin/env node
// Timeout cooldowns back off exponentially: a model that keeps hanging must
// not be retried every base interval, but must not be parked forever either.
import assert from 'node:assert/strict';

import {
  MAX_RETRY_AFTER_MS,
  TIMEOUT_BACKOFF_CAP_MS,
  candidateCooldown,
  parseRetryAfterMs,
  timeoutBackoffMs,
} from '../app/cooldown.mjs';

// First timeout = the configured base; each consecutive one doubles.
assert.equal(timeoutBackoffMs(1, 300000), 300000);
assert.equal(timeoutBackoffMs(2, 300000), 600000);
assert.equal(timeoutBackoffMs(3, 300000), 1200000);
assert.equal(timeoutBackoffMs(4, 300000), 2400000);

// Capped, so a permanently broken model still gets probed occasionally.
assert.equal(timeoutBackoffMs(10, 300000), TIMEOUT_BACKOFF_CAP_MS);
assert.equal(timeoutBackoffMs(3, 300000, 900000), 900000);
assert.equal(timeoutBackoffMs(99, 1000, 5000), 5000);

// A missing or nonsensical count behaves like the first timeout.
assert.equal(timeoutBackoffMs(0, 300000), 300000);
assert.equal(timeoutBackoffMs(-4, 300000), 300000);
assert.equal(timeoutBackoffMs(undefined, 300000), 300000);

// No configured timeout cooldown means no backoff at all.
assert.equal(timeoutBackoffMs(4, 0), 0);
assert.equal(timeoutBackoffMs(4, undefined), 0);

// Multi-key cooldowns: a model is unavailable only when every usable key is
// cooling. One hot key must not hide its healthy siblings.
const now = 1_000_000;
const until = now + 60_000;
assert.equal(candidateCooldown({ now, keyEntries: [] }), null);
assert.equal(candidateCooldown({ now, keyEntries: [null] }), null);
assert.equal(
  candidateCooldown({ now, keyEntries: [null, { until }] }),
  null,
  'one free key keeps the candidate available',
);
assert.deepEqual(
  candidateCooldown({ now, keyEntries: [{ until: now + 30_000 }, { until }] }),
  { until },
  'all cooling returns the longest wait',
);
assert.equal(
  candidateCooldown({ now, keyEntries: [{ until: now - 1 }, { until: now - 2 }] }),
  null,
  'expired cooldowns are free',
);
// A model-level cooldown covers every key.
assert.deepEqual(
  candidateCooldown({ now, modelEntry: { until }, keyEntries: [null] }),
  { until },
);
assert.equal(
  candidateCooldown({ now, modelEntry: { until: now - 1 }, keyEntries: [null] }),
  null,
);
assert.equal(candidateCooldown({ now }), null);

// Retry-After is either delta-seconds or an HTTP date; a provider that says
// "come back in 60s" must not be retried after the generic cooldown instead.
assert.equal(parseRetryAfterMs('60'), 60_000);
assert.equal(parseRetryAfterMs('0'), 0);
assert.equal(parseRetryAfterMs('1.5'), 1_500);
assert.equal(parseRetryAfterMs(''), 0);
assert.equal(parseRetryAfterMs(undefined), 0);
assert.equal(parseRetryAfterMs('not-a-date'), 0);
assert.equal(
  parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')),
  60_000,
);
assert.equal(
  parseRetryAfterMs('Wed, 21 Oct 2015 07:26:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')),
  0,
  'a date in the past means wait no longer',
);
// A broken or hostile header must not park a model for days.
assert.equal(parseRetryAfterMs('999999999'), MAX_RETRY_AFTER_MS);
assert.equal(parseRetryAfterMs('-5'), 0);

console.log('cooldown unit tests passed');
