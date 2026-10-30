#!/usr/bin/env node
// Audit log UI: a read-only table in the Settings pane fed by /api/audit,
// refreshed when the tab opens or the Refresh button is pressed.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

assert.ok(page.includes('id="audit"'), '#audit host missing');
assert.ok(page.includes('id="audit-refresh" class="ghost"'), '#audit-refresh must be a ghost button');
assert.ok(page.includes('id="audit-note"'), '#audit-note missing');
assert.match(page, /data-i18n="audit_t"/);
assert.match(page, /data-i18n="audit_d"/);
const auditAt = page.indexOf('data-i18n="audit_t"');
assert.ok(auditAt > page.indexOf('data-pane="settings"'), 'audit section lives in Settings');
assert.ok(auditAt < page.indexOf('data-pane="logs"'), 'audit section stays in Settings');

assert.match(page, /api\('api\/audit\?limit=100'\)/);
assert.match(page, /function renderAudit\(/);
assert.match(page, /function refreshAudit\(/);
assert.match(page, /refreshActiveSessions\(\);\s*refreshAudit\(\);/, 'tab entry refreshes both lists');
assert.match(page, /el\('audit-refresh'\)\.onclick = \(\) => refreshAudit\(\)/);
assert.match(page, /auditState = null;/);

for (const key of [
  'th_audit_time', 'th_audit_actor', 'th_audit_action', 'th_audit_target', 'th_audit_result',
  'audit_empty', 'audit_note',
]) {
  assert.ok(page.includes(key), `missing i18n reference ${key}`);
}

const start = page.indexOf('function renderAudit(');
const end = page.indexOf('async function refreshAudit(', start);
assert.ok(start >= 0 && end > start);
const block = page.slice(start, end);
assert.equal(block.includes('`'), false);
assert.equal(block.includes('${'), false);
assert.equal(block.includes('innerHTML'), false);

console.log('audit UI tests passed');
