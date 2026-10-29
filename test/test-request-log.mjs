#!/usr/bin/env node
// The request log is an in-memory ring of finished gateway requests. It must
// keep only the last N records, expose them newest first, and never copy a
// field the callers did not whitelist (no prompts, headers, or key values).
import assert from 'node:assert/strict';

import {
  REQUEST_LOG_CAPACITY,
  REQUEST_LOG_MAX_ATTEMPTS,
  createRequestLog,
  normalizeRequestRecord,
} from '../app/request-log.mjs';

const now = () => Date.parse('2026-10-29T10:00:00.000Z');
const iso = (date) => new Date(date).toISOString();

// ---- normalization: whitelist and coercion -------------------------------
{
  const record = normalizeRequestRecord(
    {
      id: 'req_0123456789abcdef',
      at: '2026-10-29T09:59:00.000Z',
      startedAt: '2026-10-29T09:58:59.000Z',
      durationMs: 1234,
      dialect: 'responses',
      stream: true,
      model: 'free-best',
      provider: 'mock',
      upstreamModel: 'mock/model',
      key: 'primary',
      status: 200,
      outcome: 'ok',
      reason: '',
      firstTokenMs: 250,
      fields: ['model', 'messages', 'stream'],
      attempts: [{ provider: 'mock', model: 'mock/model', key: 'primary', status: 200, ok: true, kind: '', reason: '', ms: 900 }],
      // Everything below is client content and must never be stored.
      messages: [{ role: 'user', content: 'do not keep me' }],
      keyValue: 'sk-very-secret',
      headers: { authorization: 'Bearer sk-very-secret' },
    },
    { now },
  );

  assert.deepEqual(Object.keys(record).sort(), [
    'at', 'attempts', 'dialect', 'durationMs', 'fields', 'firstTokenMs', 'id', 'key',
    'model', 'outcome', 'provider', 'reason', 'startedAt', 'status', 'stream', 'upstreamModel',
  ]);
  assert.equal(JSON.stringify(record).includes('do not keep me'), false);
  assert.equal(JSON.stringify(record).includes('sk-very-secret'), false);
  assert.equal(record.dialect, 'responses');
  assert.equal(record.stream, true);
  assert.equal(record.outcome, 'ok');
  assert.equal(record.at, '2026-10-29T09:59:00.000Z');
  assert.equal(record.status, 200);
  assert.equal(record.attempts[0].ok, true);

  // An explicit null is "no sample", not a 0 ms first token.
  const absent = normalizeRequestRecord({ firstTokenMs: null }, { now });
  assert.equal(absent.firstTokenMs, null);

  // Unknown dialect/outcome fall back instead of inventing a new state.
  const odd = normalizeRequestRecord({ dialect: 'grpc', outcome: 'melted', stream: 'yes' }, { now });
  assert.equal(odd.dialect, 'chat');
  assert.equal(odd.outcome, 'failed');
  assert.equal(odd.stream, false);
  assert.equal(odd.status, null);
  assert.equal(odd.firstTokenMs, null);
  assert.equal(odd.durationMs, 0);
}

// ---- normalization: caps and text hygiene --------------------------------
{
  const long = 'x'.repeat(400);
  const record = normalizeRequestRecord(
    {
      id: 'i'.repeat(100),
      model: long,
      provider: long,
      upstreamModel: long,
      key: long,
      reason: `bad\nthing\u0000 ${long}`,
      durationMs: -5,
      firstTokenMs: -1,
      fields: Array.from({ length: 50 }, (_, index) => `f${index}`.padEnd(50, 'y')),
      attempts: Array.from({ length: 30 }, (_, index) => ({
        provider: long,
        model: long,
        key: long,
        reason: long,
        ms: -3,
        status: 999,
        ok: 'yes',
      })),
    },
    { now },
  );
  assert.equal(record.id.length, 64);
  assert.equal(record.model.length, 200);
  assert.equal(record.provider.length, 64);
  assert.equal(record.upstreamModel.length, 200);
  assert.equal(record.key.length, 64);
  assert.ok(record.reason.length <= 240);
  assert.equal(/[\u0000-\u001f\u007f]/.test(record.reason), false, 'control characters are stripped');
  assert.equal(record.durationMs, 0);
  assert.equal(record.fields.length, 40);
  assert.equal(record.fields[0].length, 40);
  assert.equal(record.attempts.length, REQUEST_LOG_MAX_ATTEMPTS);
  assert.equal(record.attempts[0].provider.length, 64);
  assert.equal(record.attempts[0].reason.length, 240);
  assert.equal(record.attempts[0].ms, 0);
  assert.equal(record.attempts[0].status, null);
  assert.equal(record.attempts[0].ok, false);

  // Non-object attempts are dropped rather than throwing.
  const mixed = normalizeRequestRecord({ attempts: [null, 'x', { provider: 'p' }] }, { now });
  assert.equal(mixed.attempts.length, 1);
  assert.equal(mixed.attempts[0].provider, 'p');
}

// ---- timestamps ----------------------------------------------------------
{
  const fallback = normalizeRequestRecord({ at: 'not a date' }, { now });
  assert.equal(fallback.at, iso(now()));
  assert.equal(fallback.startedAt, fallback.at, 'startedAt defaults to the finish time');

  const startsBefore = normalizeRequestRecord(
    { at: '2026-10-29T10:00:01.000Z', startedAt: '2026-10-29T10:00:00.000Z' },
    { now },
  );
  assert.equal(startsBefore.startedAt, '2026-10-29T10:00:00.000Z');
}

// ---- ring buffer ---------------------------------------------------------
{
  const log = createRequestLog({ capacity: 3, now });
  assert.equal(log.capacity, 3);
  assert.ok(Number.isFinite(Date.parse(log.since)));
  for (const id of ['a', 'b', 'c', 'd']) log.add({ id, at: iso(now()), startedAt: iso(now()) });
  assert.equal(log.size, 3);
  const snapshot = log.snapshot();
  assert.equal(snapshot.capacity, 3);
  assert.equal(snapshot.size, 3);
  assert.equal(snapshot.since, log.since);
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ['d', 'c', 'b'], 'newest first');

  // The snapshot is an array copy: callers cannot reorder or grow the buffer.
  snapshot.entries.push({ id: 'injected' });
  snapshot.entries.reverse();
  assert.equal(log.size, 3);
  assert.deepEqual(log.snapshot().entries.map((entry) => entry.id), ['d', 'c', 'b']);

  const clamped = createRequestLog({ capacity: 0, now });
  assert.equal(clamped.capacity, 1);
  clamped.add({ id: 'one' });
  clamped.add({ id: 'two' });
  assert.deepEqual(clamped.snapshot().entries.map((entry) => entry.id), ['two']);

  assert.equal(createRequestLog().capacity, REQUEST_LOG_CAPACITY);
}

console.log('request-log unit tests passed');
