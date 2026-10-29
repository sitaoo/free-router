#!/usr/bin/env node
// Logs tab: one table row per client request, with the top row offering
// Refresh, Copy all, the JSONL/text exports, and Clear. Copy and both exports
// render the same three-line text; the table itself is the at-a-glance view.
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

// 2. Pane controls: five ghost buttons over the table, then the count note.
for (const id of ['logs', 'logs-refresh', 'logs-note', 'logs-copy', 'logs-export-jsonl', 'logs-export-text', 'logs-clear']) {
  assert.ok(page.includes(`id="${id}"`), `#${id} missing`);
}
for (const id of ['logs-refresh', 'logs-copy', 'logs-export-jsonl', 'logs-export-text', 'logs-clear']) {
  assert.match(page, new RegExp(`id="${id}" class="ghost[^"]*"`), `#${id} must be a ghost button`);
}
assert.match(page, /data-i18n="logs_title"/);
assert.match(page, /data-i18n="logs_blurb"/);
assert.match(page, /data-i18n="logs_copy_all"/);
assert.match(page, /data-i18n="logs_export_jsonl"/);
assert.match(page, /data-i18n="logs_export_text"/);
assert.match(page, /data-i18n="logs_clear"/);

// 3. Fetches come from /api/logs, not /api/state; Clear deletes the list.
assert.match(page, /api\('api\/logs'\)/, 'logs must use the dedicated endpoint');
assert.match(page, /api\('api\/logs', \{ method: 'DELETE' \}\)/, 'Clear must delete the in-memory records');
assert.match(page, /confirm\(t\('logs_clear_confirm'\)\)/, 'clearing must ask first');

// 4. Polling: 5s, only on the logs tab, only visible, only while logged in,
// and never overlapping.
assert.match(page, /LOGS_REFRESH_MS\s*=\s*5000/);
assert.match(page, /activeTab\s*!==\s*['"]logs['"]/);
assert.match(page, /document\.hidden/);
assert.match(page, /!state/);
assert.match(page, /logsRefreshing/);
assert.match(page, /function startLogsAutoRefresh/);

// 5. The table is back: eleven columns, result pills, an answer-shape line, and
// at most three attempts per row.
assert.match(page, /function renderLogs\(/);
assert.match(page, /renderLogs\(\);/, 'renderAll must render the cached logs');
assert.match(page, /function logResultKind\(/);
assert.match(page, /function logAttemptsCell\(/);
for (const key of [
  'th_logs_time', 'th_logs_dialect', 'th_logs_requested', 'th_logs_selected',
  'th_logs_result', 'th_logs_duration', 'th_logs_first_token', 'th_logs_input_tokens',
  'th_logs_output_tokens', 'th_logs_speed', 'th_logs_attempts',
]) {
  assert.ok(page.includes(key), `the table must have a ${key} column`);
}
for (const key of ['log_ok', 'log_empty', 'log_interrupted', 'log_aborted', 'log_blocked', 'log_failed', 'log_rejected']) {
  assert.ok(page.includes(key), `result pills must translate ${key}`);
}
assert.match(page, /logs_answer/, 'each row shows finish reason, tool calls, and character count');
assert.match(page, /logs_more/, 'long attempt lists collapse into a remainder line');
// The cell is 220px wide, so the visible lines are always cut short: hovering
// must reveal the complete text of every attempt, not just the first three.
assert.match(page, /cell\.title = /, 'the attempts cell must expose every attempt on hover');
assert.match(page, /line\.title = logAttemptText\(attempt\)/, 'a visible line must expose its full text on hover');
assert.match(page, /attempts\.map\(logAttemptText\)/, 'the hover hint covers all attempts, not only the three shown');
assert.match(page, /logs_tries/, 'the attempts cell counts its lines');
assert.doesNotMatch(page, /log-copy/, 'no per-row copy button');
assert.doesNotMatch(page, /logs_copy_one/, 'the per-row copy wording is gone');

// 6. Copy and the exports use the same plain-text shape: three lines per
// request, the fields a bug report needs.
assert.match(page, /function logEntryText\(/);
for (const token of ['finish=', 'tools=', 'chars=', 'tokens=', 'tps=', 'fields=', 'logs_tries']) {
  assert.ok(page.includes(token), `the entry text must include ${token}`);
}
assert.match(page, /function logAllText\(/);
assert.match(page, /function logJsonl\(/);
assert.match(page, /JSON\.stringify\(entry\)/, 'JSONL export keeps every field');
for (const key of ['logs_copied', 'logs_copy_failed', 'logs_cleared', 'logs_empty', 'logs_count']) {
  assert.ok(page.includes(key), `logs UI must reference ${key}`);
}

// 7. Copy works over plain HTTP on the LAN (no secure context), and export
// downloads a real file.
assert.match(page, /window\.isSecureContext/, 'clipboard API needs a secure context');
assert.match(page, /document\.execCommand\('copy'\)/, 'execCommand fallback for plain-HTTP LAN access');
assert.match(page, /new Blob\(/, 'exports are built as downloads');
assert.match(page, /\.jsonl/, 'JSONL export filename');
assert.match(page, /application\/x-ndjson/, 'JSONL export media type');

// 8. Log data reaches the DOM as text only, and the embedded script stays free
// of template-literal syntax.
const renderStart = page.indexOf('function logReasonText');
const renderEnd = page.indexOf('async function refreshLogs');
assert.ok(renderStart !== -1 && renderEnd > renderStart, 'log render helpers must exist');
const renderBlock = page.slice(renderStart, renderEnd);
assert.equal(renderBlock.includes('innerHTML'), false, 'log data must never be assigned as HTML');
assert.equal(renderBlock.includes('`'), false, 'embedded script must not use backticks');
assert.equal(renderBlock.includes('${'), false, 'embedded script must not use template expressions');

console.log('logs UI tests passed');
