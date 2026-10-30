#!/usr/bin/env node
// Unit tests for the audit trail format (app/audit.mjs): one JSON object per
// line, newline injection impossible, fields capped, junk tolerated.
import assert from 'node:assert/strict';

import { formatAuditLine, normalizeAuditRecord, parseAuditLines } from '../app/audit.mjs';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

// A normal record keeps its fields and gets a parseable timestamp.
{
  const record = normalizeAuditRecord(
    { action: 'auth.login', actor: 'admin', target: 'browser', result: 'ok', ip: '10.0.0.5', detail: 'ok' },
    NOW,
  );
  assert.deepEqual(record, {
    at: new Date(NOW).toISOString(),
    actor: 'admin',
    action: 'auth.login',
    target: 'browser',
    result: 'ok',
    ip: '10.0.0.5',
    detail: 'ok',
  });
}

// Defaults: admin actor, ok result, empty strings.
{
  const record = normalizeAuditRecord({ action: 'system.boot' }, NOW);
  assert.equal(record.actor, 'admin');
  assert.equal(record.result, 'ok');
  assert.equal(record.target, '');
  assert.equal(record.ip, '');
}

// A newline in any field is flattened, so one event cannot forge a second
// line, and every field is capped.
{
  const record = normalizeAuditRecord(
    {
      action: 'gateway.key.create\n{"at":"1999-01-01","action":"fake"}',
      detail: 'x'.repeat(500),
      actor: 'a'.repeat(100),
    },
    NOW,
  );
  assert.equal(record.action.includes('\n'), false);
  assert.ok(record.action.length <= 64);
  assert.ok(record.detail.length <= 240);
  assert.ok(record.actor.length <= 64);
  const line = formatAuditLine({ action: 'x\ny' }, NOW);
  assert.equal(line.split('\n').length, 1);
  assert.equal(JSON.parse(line).action, 'x y');
}

// Only "fail" is a failure; anything else normalizes to ok.
assert.equal(normalizeAuditRecord({ action: 'a', result: 'fail' }).result, 'fail');
assert.equal(normalizeAuditRecord({ action: 'a', result: 'bogus' }).result, 'ok');

// A bad timestamp is replaced, not propagated.
assert.equal(normalizeAuditRecord({ action: 'a', at: 'nope' }, NOW).at, new Date(NOW).toISOString());

// Parsing skips torn and non-object lines but keeps valid ones.
{
  const text = [
    formatAuditLine({ action: 'auth.login', result: 'ok' }, NOW),
    '{"action": "auth.login", "result": "fail"',
    '',
    '42',
    '{"action": "gateway.key.delete", "result": "ok"}',
  ].join('\n');
  const records = parseAuditLines(text);
  assert.deepEqual(records.map((record) => record.action), ['auth.login', 'gateway.key.delete']);
  assert.deepEqual(parseAuditLines(''), []);
  assert.deepEqual(parseAuditLines(undefined), []);
}

console.log('audit unit tests passed');
