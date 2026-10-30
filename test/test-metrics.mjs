#!/usr/bin/env node
// Prometheus text rendering (app/metrics.mjs): stable metric names, escaped
// labels, no NaN, and only the series that carry data.
import assert from 'node:assert/strict';

import { formatMetrics } from '../app/metrics.mjs';

const text = formatMetrics({
  version: '1.2.3',
  startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
  now: Date.UTC(2026, 0, 1, 0, 0, 30),
  pool: { free: ['a', 'b'], paid: ['c'] },
  totals: {
    requests: 4,
    outcomes: { ok: 3, failed: 1, rejected: 0 },
    inputTokens: 120,
    outputTokens: 30,
    durationMs: 4000,
    firstTokenMs: 600,
    firstTokenSamples: 3,
  },
  cooldowns: [{ id: 'a' }, { id: 'b' }],
  gatewayKeys: [
    { name: 'laptop', usedToday: 2, dailyLimit: 10 },
    { name: 'ci', usedToday: 0, dailyLimit: null },
  ],
});

const lines = text.trim().split('\n');
const value = (name) => {
  const line = lines.find((entry) => entry.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : null;
};
const series = (name) => lines.filter((entry) => entry.startsWith(`${name}{`));

assert.ok(text.endsWith('\n'), 'text format ends with a newline');
assert.equal(value('free_router_up'), 1);
assert.equal(value('free_router_uptime_seconds'), 30);
assert.equal(value('free_router_pool_models{kind="free"}'), 2);
assert.equal(value('free_router_pool_models{kind="paid"}'), 1);
assert.equal(value('free_router_requests_total{outcome="ok"}'), 3);
assert.equal(value('free_router_requests_total{outcome="failed"}'), 1);
assert.equal(
  series('free_router_requests_total').some((line) => line.includes('rejected')),
  false,
  'zero series are omitted',
);
assert.equal(value('free_router_request_duration_seconds_sum'), 4);
assert.equal(value('free_router_request_duration_seconds_count'), 4);
assert.equal(value('free_router_first_token_seconds_sum'), 0.6);
assert.equal(value('free_router_first_token_seconds_count'), 3);
assert.equal(value('free_router_tokens_total{direction="input"}'), 120);
assert.equal(value('free_router_tokens_total{direction="output"}'), 30);
assert.equal(value('free_router_cooldown_models'), 2);
assert.equal(value('free_router_gateway_key_requests_today{name="laptop"}'), 2);
assert.equal(value('free_router_gateway_key_limit{name="laptop"}'), 10);
assert.equal(
  series('free_router_gateway_key_limit').some((line) => line.includes('"ci"')),
  false,
  'an unlimited key has no limit series',
);
assert.match(text, /free_router_info\{version="1\.2\.3"\} 1/);

// Labels are escaped, and an empty snapshot still renders valid text.
const escaped = formatMetrics({
  version: 'x"y\\z',
  startedAt: 0,
  now: 0,
  pool: { free: [], paid: [] },
  totals: { requests: 0, outcomes: {}, inputTokens: 0, outputTokens: 0, durationMs: 0, firstTokenMs: 0, firstTokenSamples: 0 },
  cooldowns: [],
  gatewayKeys: [{ name: 'a"b\\c\nd', usedToday: 1, dailyLimit: null }],
});
assert.match(escaped, /free_router_info\{version="x\\"y\\\\z"\} 1/);
assert.match(escaped, /free_router_gateway_key_requests_today\{name="a\\"b\\\\c d"\} 1/);
assert.equal(/NaN|Infinity/.test(escaped), false);
assert.equal(/^# HELP /m.test(escaped), true, 'every metric family has HELP text');

console.log('metrics unit tests passed');
