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
  parseRequestLogLines,
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
      finishReason: 'tool_calls',
      toolCalls: 1,
      contentChars: 0,
      reasoningChars: 12,
      inputTokens: 321,
      outputTokens: 45,
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
    'at', 'attempts', 'contentChars', 'dialect', 'durationMs', 'fields', 'finishReason',
    'firstTokenMs', 'id', 'inputTokens', 'key', 'model', 'outcome', 'outputTokens',
    'outputTps', 'provider', 'reason', 'reasoningChars', 'startedAt', 'status', 'stream',
    'toolCalls', 'upstreamModel',
  ]);
  assert.equal(JSON.stringify(record).includes('do not keep me'), false);
  assert.equal(JSON.stringify(record).includes('sk-very-secret'), false);
  assert.equal(record.dialect, 'responses');
  assert.equal(record.stream, true);
  assert.equal(record.outcome, 'ok');
  assert.equal(record.at, '2026-10-29T09:59:00.000Z');
  assert.equal(record.status, 200);
  assert.equal(record.attempts[0].ok, true);
  assert.equal(record.finishReason, 'tool_calls');
  assert.equal(record.toolCalls, 1);
  assert.equal(record.contentChars, 0);
  assert.equal(record.reasoningChars, 12);
  assert.equal(record.inputTokens, 321);
  assert.equal(record.outputTokens, 45);
  // Speed excludes the wait for the first token: 45 tokens over the 984 ms
  // the model was actually generating, not over the whole request.
  assert.equal(record.outputTps, 45.7);

  // Without a first-token sample there is no generation window, so the whole
  // request is the conservative denominator, and no output means no speed.
  const jsonLike = normalizeRequestRecord({ outputTokens: 100, durationMs: 2000 }, { now });
  assert.equal(jsonLike.outputTps, 50);
  assert.equal(normalizeRequestRecord({ outputTokens: 0, durationMs: 1000 }, { now }).outputTps, null);
  assert.equal(normalizeRequestRecord({ outputTokens: 9, firstTokenMs: 2000, durationMs: 2000 }, { now }).outputTps, 4.5);

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
      finishReason: `stop\n${long}`,
      toolCalls: -1,
      contentChars: 'many',
      reasoningChars: 1e15,
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
  assert.equal(record.finishReason.length, 40);
  assert.equal(/[\u0000-\u001f\u007f]/.test(record.finishReason), false);
  assert.equal(record.toolCalls, 0);
  assert.equal(record.contentChars, 0);
  assert.equal(record.reasoningChars, 1_000_000_000);
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

// ---- clearing ------------------------------------------------------------
{
  const log = createRequestLog({ capacity: 5, now });
  log.add({ id: 'a' });
  log.add({ id: 'b' });
  const cleared = log.clear();
  assert.equal(cleared, 2, 'clear reports how many records it removed');
  assert.equal(log.size, 0);
  assert.deepEqual(log.snapshot().entries, []);
  assert.equal(log.capacity, 5, 'clearing keeps the buffer configuration');
  assert.equal(log.since, createRequestLog({ now }).since, 'since marks process start, not the clear');
  assert.equal(log.clear(), 0, 'clearing an empty log is a no-op');
  log.add({ id: 'c' });
  assert.deepEqual(log.snapshot().entries.map((entry) => entry.id), ['c']);
}

// ---- persisted file parsing ----------------------------------------------
{
  const text = [
    JSON.stringify({ id: 'req_1', outcome: 'ok' }),
    '{"id": "req_2", "outcome": "ok"',
    '',
    'null',
    JSON.stringify({ id: 'req_3', outcome: 'failed' }),
  ].join('\n');
  const records = parseRequestLogLines(text);
  assert.deepEqual(records.map((record) => record.id), ['req_1', 'req_3'], 'torn and null lines are skipped');
  assert.deepEqual(parseRequestLogLines(text, { limit: 1 }).map((record) => record.id), ['req_3']);
  assert.deepEqual(parseRequestLogLines(''), []);
  assert.deepEqual(parseRequestLogLines(undefined), []);
}

console.log('request-log unit tests passed');
