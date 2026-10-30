#!/usr/bin/env node
// Unit tests for admin session management (app/sessions.mjs): ids are hashes,
// listing hides the token and skips expired rows, revocation by id and
// "everywhere else" only touch what they name.
import assert from 'node:assert/strict';

import {
  listSessions,
  normalizeClient,
  pruneExpiredSessions,
  revokeSessions,
  sessionId,
} from '../app/sessions.mjs';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

// The id is derived, stable, short, and never the token itself.
{
  const token = 'a'.repeat(64);
  const id = sessionId(token);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, sessionId(token));
  assert.notEqual(id, sessionId(`${token}b`));
  assert.equal(id.includes(token), false);
}

// User agents are flattened and capped.
assert.equal(normalizeClient('Mozilla/5.0\r\n\t(Foo)'), 'Mozilla/5.0 (Foo)');
assert.equal(normalizeClient(undefined), '');
assert.equal(normalizeClient('x'.repeat(300)).length, 120);
assert.ok(normalizeClient('x'.repeat(300)).endsWith('…'));

// Listing: expired entries skipped, current marked, newest first, token gone.
{
  const sessions = new Map([
    ['tok-old', { expiresAt: NOW + 1000, createdAt: NOW - 2000, ip: '10.0.0.2', userAgent: 'Old' }],
    ['tok-new', { expiresAt: NOW + 1000, createdAt: NOW - 1000, ip: '10.0.0.3', userAgent: 'New' }],
    ['tok-dead', { expiresAt: NOW - 1, createdAt: NOW - 500, ip: '10.0.0.4', userAgent: 'Dead' }],
    ['tok-forever', { expiresAt: Number.POSITIVE_INFINITY, createdAt: NOW - 3000, ip: '', userAgent: '' }],
  ]);
  const rows = listSessions(sessions, { now: NOW, currentToken: 'tok-new' });
  assert.deepEqual(rows.map((row) => row.ip), ['10.0.0.3', '10.0.0.2', '']);
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].current, false);
  assert.equal(rows[0].expiresAt, new Date(NOW + 1000).toISOString());
  assert.equal(rows[2].expiresAt, null);
  assert.equal(rows[2].client, '');
  assert.equal(JSON.stringify(rows).includes('tok-new'), false);
}

// Revoke one by id: only that session goes.
{
  const sessions = new Map([
    ['one', { expiresAt: NOW + 1000 }],
    ['two', { expiresAt: NOW + 1000 }],
  ]);
  assert.equal(revokeSessions(sessions, { id: sessionId('one'), currentToken: 'two' }), 1);
  assert.deepEqual([...sessions.keys()], ['two']);
  assert.equal(revokeSessions(sessions, { id: 'nope' }), 0);
}

// Revoke everywhere else: the caller's session survives.
{
  const sessions = new Map([
    ['mine', { expiresAt: NOW + 1000 }],
    ['other-1', { expiresAt: NOW + 1000 }],
    ['other-2', { expiresAt: NOW + 1000 }],
  ]);
  assert.equal(revokeSessions(sessions, { others: true, currentToken: 'mine' }), 2);
  assert.deepEqual([...sessions.keys()], ['mine']);
}

// Pruning drops expired sessions and keeps live ones, including "never".
{
  const sessions = new Map([
    ['live', { expiresAt: NOW + 1000 }],
    ['never', { expiresAt: Number.POSITIVE_INFINITY }],
    ['dead', { expiresAt: NOW - 1000 }],
    ['junk', null],
  ]);
  assert.equal(pruneExpiredSessions(sessions, NOW), 2);
  assert.deepEqual([...sessions.keys()], ['live', 'never']);
}

console.log('session unit tests passed');
