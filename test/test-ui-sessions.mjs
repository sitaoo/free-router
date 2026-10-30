#!/usr/bin/env node
// Session manager UI: the Admin section lists active logins from
// /api/sessions, marks the caller's own row, and can revoke one session or
// every other one. Tokens never reach the page — rows carry a hash id.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

// 1. The list lives in the Admin section, next to the TTL control.
assert.ok(page.includes('id="sessions"'), '#sessions host missing');
assert.ok(page.includes('id="sess-revoke-others"'), '#sess-revoke-others missing');
assert.match(page, /data-i18n="sess_list_t"/);
assert.match(page, /data-i18n="sess_list_d"/);
assert.match(page, /id="sess-revoke-others" class="ghost"/, 'the bulk action is a ghost button');
const adminAt = page.indexOf('data-i18n="admin_title"');
const sessionsAt = page.indexOf('id="sessions"');
assert.ok(adminAt >= 0 && sessionsAt > adminAt, 'sessions must sit inside the Admin section');
assert.ok(sessionsAt < page.indexOf('data-pane="logs"'), 'sessions stay in Settings');

// 2. Data comes from the dedicated endpoint, refreshed on tab entry, never
// from the 5-second state poll.
assert.match(page, /api\('api\/sessions'\)/);
assert.match(page, /function refreshActiveSessions\(/);
assert.match(page, /button\.dataset\.tab === 'settings'\) refreshActiveSessions\(\)/);
assert.equal(/state\.sessions/.test(page), false, 'sessions must not ride /api/state');

// 3. Revocation posts an action and handles signing yourself out.
assert.match(page, /action: 'revoke', id: row\.id/);
assert.match(page, /action: 'revoke-others'/);
assert.match(page, /result\.signedOut/);
assert.match(page, /sess_confirm_self/);

// 4. Every column and action label is translated.
for (const key of [
  'th_sess_id', 'th_sess_created', 'th_sess_expires', 'th_sess_ip', 'th_sess_client',
  'sess_revoke', 'sess_current', 'sess_revoked', 'sess_none', 'sess_confirm',
  'sess_others_confirm',
]) {
  assert.ok(page.includes(key), `missing i18n reference ${key}`);
}

// 5. The render block stays template-literal safe (no backticks, no ${).
const start = page.indexOf('function renderActiveSessions(');
const end = page.indexOf('/* ===== Timezone combobox', start);
assert.ok(start >= 0 && end > start, 'renderActiveSessions block not found');
const block = page.slice(start, end);
assert.equal(block.includes('`'), false, 'no template literals in the inline script');
assert.equal(block.includes('${'), false, 'no template interpolation in the inline script');
assert.equal(block.includes('innerHTML'), false, 'render with textContent only');

console.log('sessions UI tests passed');
