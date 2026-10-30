#!/usr/bin/env node
// Verdict hygiene: a verdict is a cache entry, not a fact. Both "free" and
// "not free" answers must expire, and re-observing the same answer must
// refresh the timestamp — otherwise a model that keeps failing is re-probed
// forever because its old timestamp never moves.
import assert from 'node:assert/strict';

import { mergeVerdict, verdictFor } from '../app/verdicts.mjs';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const TTL = 60_000;
const verdicts = {
  fresh: { free: false, observedAt: '2026-10-30T11:59:30.000Z' },
  stale: { free: false, observedAt: '2026-10-30T11:58:00.000Z' },
  freeFresh: { free: true, observedAt: '2026-10-30T11:59:30.000Z' },
  freeStale: { free: true, observedAt: '2026-10-30T11:58:00.000Z' },
  timeless: { free: false },
};

assert.equal(verdictFor(verdicts, 'missing', NOW, TTL), null);
assert.deepEqual(verdictFor(verdicts, 'fresh', NOW, TTL), verdicts.fresh);
assert.equal(verdictFor(verdicts, 'stale', NOW, TTL), null, 'a negative verdict expires');
assert.deepEqual(verdictFor(verdicts, 'freeFresh', NOW, TTL), verdicts.freeFresh);
assert.equal(verdictFor(verdicts, 'freeStale', NOW, TTL), null, 'a positive verdict expires too');
assert.equal(verdictFor(verdicts, 'timeless', NOW, TTL), null, 'no timestamp means no trust');

// Re-observing the same answer still refreshes observedAt.
const merged = mergeVerdict(
  { free: false, reason: 'gone', observedAt: '2026-10-30T11:00:00.000Z' },
  { free: false, reason: 'gone' },
  '2026-10-30T12:00:00.000Z',
);
assert.equal(merged.observedAt, '2026-10-30T12:00:00.000Z');
assert.equal(merged.free, false);
assert.equal(merged.reason, 'gone');

// A new answer replaces the old fields it names and keeps the rest.
const updated = mergeVerdict(
  { free: true, dailyRequestLimit: 50, observedAt: '2026-10-30T11:00:00.000Z' },
  { free: false, reason: 'billed now' },
  '2026-10-30T12:00:00.000Z',
);
assert.deepEqual(updated, {
  free: false,
  dailyRequestLimit: 50,
  reason: 'billed now',
  observedAt: '2026-10-30T12:00:00.000Z',
});

console.log('verdict unit tests passed');
