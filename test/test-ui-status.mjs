#!/usr/bin/env node
// Status tab: usage before the model pool, plus 5s auto-refresh while on
// status. The old Routes/Quota tabs are gone; their content lives elsewhere.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

// 1. Order: Usage today section must come before Pool priority.
const usageAt = page.indexOf('id="usage"');
const poolAt = page.indexOf('id="pool"');
assert.ok(usageAt !== -1 && poolAt !== -1, 'status pane must contain #usage and #pool');
assert.ok(usageAt < poolAt, `usage (#usage at ${usageAt}) must precede pool (#pool at ${poolAt})`);
assert.match(page, /data-i18n="pool_priority"/, 'pool section must use the pool_priority label');
assert.doesNotMatch(page, /data-tab="routes"/, 'Routes tab must be gone');
assert.doesNotMatch(page, /data-tab="quota"/, 'Quota tab must be gone');
assert.doesNotMatch(page, /id="routes"/, 'no route priority table');
assert.doesNotMatch(page, /id="limits-table"/, 'daily limits moved to the provider model table');
assert.doesNotMatch(page, /route-select/, 'route editor must be gone');

// 2. The priority table reads the pool, not a route map.
assert.match(page, /state\.pool/, 'status must render state.pool');
assert.match(page, /pool\.paid/, 'paid pool must be rendered separately');
assert.match(page, /pool_paid_note/, 'paid pool must explain that only named requests use it');

// 3. Auto-refresh: default 5s interval, only on status tab, skipped when hidden/logged-out/busy.
assert.match(page, /5000/, 'page must contain default 5s refresh interval');
assert.match(page, /setInterval/, 'page must schedule refresh with setInterval');
assert.match(page, /activeTab\s*!==?\s*['"]status['"]/, 'refresh must only run on the status tab');
assert.match(page, /document\.hidden/, 'refresh must skip when page is hidden');
assert.match(page, /!state/, 'refresh must skip when logged out (no state)');

// 4. The displayed API address follows the browser, not the bind address:
// 0.0.0.0 is not routable, so derive it from the current origin instead.
assert.doesNotMatch(page, /id="endpoint"/, 'topbar must not print the bind address');
assert.doesNotMatch(page, /state\.endpoint/, 'UI must not print the server bind endpoint');
assert.match(page, /location\.origin \+ ['"]\/v1['"]/, 'endpoint must come from the current origin');
assert.match(page, /function gatewayEndpoint/, 'one helper for every displayed endpoint');

// 5. Turning LAN access on is a plaintext-to-the-network decision, so the
// server section must say so in danger colour, and only while it is on.
assert.match(page, /id="srv-lan-insecure"/, 'LAN plaintext warning slot missing');
assert.match(
  page,
  /class="[^"]*\bwarn-banner\b[^"]*"[^>]*id="srv-lan-insecure"|id="srv-lan-insecure"[^>]*class="[^"]*\bwarn-banner\b/,
  'LAN warning must use the danger banner style',
);
assert.match(page, /\.warn-banner\s*\{[^}]*var\(--bad/, 'warning banner must be red in both themes');
assert.match(page, /srv_lan_insecure/, 'warning text must be translated, not hard-coded');
// It follows the switch: rendered by renderLanAddrs, hidden when LAN is off.
assert.match(
  page,
  /function renderLanAddrs\(lanOn\)[\s\S]{0,4000}?srv-lan-insecure/,
  'warning must be rendered by the LAN renderer',
);
assert.match(
  page,
  /srv-lan-insecure[\s\S]{0,200}?!lanOn/,
  'warning must be hidden while LAN access is off',
);

console.log('ui-status unit tests passed');
