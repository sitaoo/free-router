#!/usr/bin/env node
// Logs tab: one block of plain text per client request, built to be pasted
// into a bug report — plus Copy all, per-entry Copy, and text/JSONL exports.
// The tab shows metadata from /api/logs and never renders request content.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

// 1. A fifth tab, and its pane lives after Settings (the providers test slices
// between providers and settings; a later pane cannot disturb it).
assert.match(page, /data-tab="logs"/, 'logs tab button missing');
assert.match(page, /data-i18n="tab_logs"/, 'logs tab label must be translated');
assert.equal((page.match(/data-pane="logs"/g) || []).length, 1, 'exactly one logs pane');
const logsPaneAt = page.indexOf('data-pane="logs"');
assert.ok(logsPaneAt > page.indexOf('data-pane="settings"'), 'logs pane must follow settings');
assert.ok(logsPaneAt < page.indexOf('</main>'), 'logs pane must stay inside main');

// 2. Pane controls and static copy.
for (const id of ['logs', 'logs-refresh', 'logs-note', 'logs-copy', 'logs-export-jsonl', 'logs-export-text']) {
  assert.ok(page.includes(`id="${id}"`), `#${id} missing`);
}
assert.match(page, /data-i18n="logs_title"/);
assert.match(page, /data-i18n="logs_blurb"/);
assert.match(page, /data-i18n="logs_copy_all"/);
assert.match(page, /data-i18n="logs_export_jsonl"/);
assert.match(page, /data-i18n="logs_export_text"/);

// 3. Fetches come from /api/logs, not /api/state.
assert.match(page, /api\('api\/logs'\)/, 'logs must use the dedicated endpoint');

// 4. Polling: 5s, only on the logs tab, only visible, only while logged in,
// and never overlapping.
assert.match(page, /LOGS_REFRESH_MS\s*=\s*5000/);
assert.match(page, /activeTab\s*!==\s*['"]logs['"]/);
assert.match(page, /document\.hidden/);
assert.match(page, /!state/);
assert.match(page, /logsRefreshing/);
assert.match(page, /function startLogsAutoRefresh/);

// 5. Rendering is plain text, one block per request: the same three lines that
// Copy and the exports use, with the fields a bug report needs.
assert.match(page, /function logEntryText\(/);
assert.match(page, /function renderLogs\(/);
assert.match(page, /renderLogs\(\);/, 'renderAll must render the cached logs');
assert.match(page, /className = 'log-entry'/);
assert.match(page, /className = 'log-text'/);
assert.doesNotMatch(page, /logAttemptsCell/, 'the table cell renderer is gone');
for (const token of ['entry.id', 'entry.outcome', 'finish=', 'tools=', 'chars=', 'fields=', 'logs_tries']) {
  assert.ok(page.includes(token), `the entry text must include ${token}`);
}
for (const key of [
  'logs_empty', 'logs_count', 'logs_tries', 'logs_copied', 'logs_copy_failed',
  'logs_copy_all', 'logs_copy_one', 'logs_export_jsonl', 'logs_export_text',
]) {
  assert.ok(page.includes(key), `logs UI must reference ${key}`);
}
assert.match(page, /\.log-text\s*\{[^}]*white-space: pre-wrap/, 'log text wraps instead of scrolling sideways');
assert.match(page, /\.log-entry\s*\{/, 'each request gets its own block');

// 6. Copy works over plain HTTP on the LAN (no secure context), and export
// downloads a real file.
assert.match(page, /window\.isSecureContext/, 'clipboard API needs a secure context');
assert.match(page, /document\.execCommand\('copy'\)/, 'execCommand fallback for plain-HTTP LAN access');
assert.match(page, /new Blob\(/, 'exports are built as downloads');
assert.match(page, /\.jsonl/, 'JSONL export filename');
assert.match(page, /application\/x-ndjson/, 'JSONL export media type');
assert.match(page, /function logJsonl\(/);
assert.match(page, /JSON\.stringify\(entry\)/, 'JSONL export keeps every field');

// 7. Log data reaches the DOM as text only, and the embedded script stays free
// of template-literal syntax.
const renderStart = page.indexOf('function logReasonText');
const renderEnd = page.indexOf('async function refreshLogs');
assert.ok(renderStart !== -1 && renderEnd > renderStart, 'log render helpers must exist');
const renderBlock = page.slice(renderStart, renderEnd);
assert.equal(renderBlock.includes('innerHTML'), false, 'log data must never be assigned as HTML');
assert.equal(renderBlock.includes('`'), false, 'embedded script must not use backticks');
assert.equal(renderBlock.includes('${'), false, 'embedded script must not use template expressions');

console.log('logs UI tests passed');
