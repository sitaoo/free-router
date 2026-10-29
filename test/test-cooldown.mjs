#!/usr/bin/env node
// Timeout cooldowns back off exponentially: a model that keeps hanging must
// not be retried every base interval, but must not be parked forever either.
import assert from 'node:assert/strict';

import { TIMEOUT_BACKOFF_CAP_MS, timeoutBackoffMs } from '../app/cooldown.mjs';

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

console.log('cooldown unit tests passed');
