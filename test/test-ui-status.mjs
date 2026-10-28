#!/usr/bin/env node
// Status tab: usage before routes, plus 5s auto-refresh while on status.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

// 1. Order: Usage today section must come before Route priority section.
const usageAt = page.indexOf('id="usage"');
const routesAt = page.indexOf('id="routes"');
assert.ok(usageAt !== -1 && routesAt !== -1, 'status pane must contain #usage and #routes');
assert.ok(usageAt < routesAt, `usage (#usage at ${usageAt}) must precede routes (#routes at ${routesAt})`);

// 2. Auto-refresh: default 5s interval, only on status tab, skipped when hidden/logged-out/busy.
assert.match(page, /5000/, 'page must contain default 5s refresh interval');
assert.match(page, /setInterval/, 'page must schedule refresh with setInterval');
assert.match(page, /activeTab\s*!==?\s*['"]status['"]/, 'refresh must only run on the status tab');
assert.match(page, /document\.hidden/, 'refresh must skip when page is hidden');
assert.match(page, /!state/, 'refresh must skip when logged out (no state)');

// 3. The displayed API address follows the browser, not the bind address:
// 0.0.0.0 is not routable, so derive it from the current origin instead.
assert.doesNotMatch(page, /id="endpoint"/, 'topbar must not print the bind address');
assert.doesNotMatch(page, /state\.endpoint/, 'UI must not print the server bind endpoint');
assert.match(page, /location\.origin \+ ['"]\/v1['"]/, 'endpoint must come from the current origin');
assert.match(page, /function gatewayEndpoint/, 'one helper for every displayed endpoint');

// 4. Turning LAN access on is a plaintext-to-the-network decision, so the
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
