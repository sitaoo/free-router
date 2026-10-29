#!/usr/bin/env node
// Logs tab: one row per client request, fetched only while the tab is visible,
// with a manual refresh. The table shows metadata from /api/logs and never
// renders request content.
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
for (const id of ['logs', 'logs-refresh', 'logs-note']) {
  assert.ok(page.includes(`id="${id}"`), `#${id} missing`);
}
assert.match(page, /data-i18n="logs_title"/);
assert.match(page, /data-i18n="logs_blurb"/);

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

// 5. Rendering: one helper, called from renderAll, covering every outcome and
// column.
assert.match(page, /function renderLogs\(/);
assert.match(page, /renderLogs\(\);/, 'renderAll must render the cached logs');
for (const key of [
  'log_ok', 'log_empty', 'log_interrupted', 'log_aborted', 'log_blocked', 'log_failed', 'log_rejected',
  'th_logs_time', 'th_logs_dialect', 'th_logs_requested', 'th_logs_selected',
  'th_logs_result', 'th_logs_duration', 'th_logs_first_token', 'th_logs_attempts',
  'logs_empty', 'logs_count', 'logs_tries', 'logs_more',
]) {
  assert.ok(page.includes(key), `logs UI must reference ${key}`);
}
assert.match(page, /#usage, #pool, #providers, #gateway, #logs\s*\{/, 'logs table must scroll inside its card');

// 6. Log data reaches the DOM as text only, and the embedded script stays free
// of template-literal syntax.
const renderStart = page.indexOf('function logResultKind');
const renderEnd = page.indexOf('async function refreshLogs');
assert.ok(renderStart !== -1 && renderEnd > renderStart, 'log render helpers must exist');
const renderBlock = page.slice(renderStart, renderEnd);
assert.equal(renderBlock.includes('innerHTML'), false, 'log data must never be assigned as HTML');
assert.equal(renderBlock.includes('`'), false, 'embedded script must not use backticks');
assert.equal(renderBlock.includes('${'), false, 'embedded script must not use template expressions');

console.log('logs UI tests passed');
