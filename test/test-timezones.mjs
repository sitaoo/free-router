#!/usr/bin/env node
// Timezone support: the IANA list the picker offers, canonicalisation and
// offset labels shared with /api/settings, and the searchable combobox the
// settings page renders in place of the old free-text box.
import assert from 'node:assert/strict';

import { listTimeZones, normalizeTimeZone, timeZoneOffsetLabel } from '../app/timezones.mjs';
import { renderPage } from '../app/ui.mjs';

// 1. The offered list is the runtime's own IANA vocabulary plus UTC. Using the
// runtime's list (rather than a checked-in table) means the picker can never
// offer a zone the server rejects, and never drifts with tzdata updates.
const zones = listTimeZones();
assert.ok(zones.length > 300, `expected the full IANA list, got ${zones.length}`);
assert.equal(zones[0], 'UTC', 'UTC must lead: it is the canonical "no DST" choice');
assert.ok(zones.includes('Asia/Shanghai'), 'Asia/Shanghai missing');
assert.ok(zones.includes('America/Los_Angeles'), 'America/Los_Angeles missing');
assert.equal(new Set(zones).size, zones.length, 'zone list must not repeat an entry');
assert.deepEqual(
  zones.slice(1),
  [...zones.slice(1)].sort(),
  'the IANA tail stays sorted, so the unfiltered dropdown reads as an index',
);
for (const zone of zones) {
  assert.doesNotMatch(zone, /\s/, `zone id ${zone} must not contain whitespace`);
}

// 2. Saving accepts what Intl accepts, canonicalised — "asia/shanghai" and the
// deprecated alias "Asia/Kolkata" must not be stored as typed.
assert.equal(normalizeTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
assert.equal(normalizeTimeZone('asia/shanghai'), 'Asia/Shanghai');
assert.equal(normalizeTimeZone('  Asia/Shanghai  '), 'Asia/Shanghai');
assert.equal(normalizeTimeZone('Asia/Kolkata'), 'Asia/Calcutta');
assert.equal(normalizeTimeZone('UTC'), 'UTC');
assert.equal(normalizeTimeZone('utc'), 'UTC');

// Clearing the field stays legal: it means "use this machine's dates".
assert.equal(normalizeTimeZone(''), '');
assert.equal(normalizeTimeZone('   '), '');
assert.equal(normalizeTimeZone(null), '');
assert.equal(normalizeTimeZone(undefined), '');

// Everything else is rejected at save time instead of only being noticed in
// the log after a restart.
assert.equal(normalizeTimeZone('Mars/Olympus_Mons'), null);
assert.equal(normalizeTimeZone('Asia/Shanghai\n'), 'Asia/Shanghai');
assert.equal(normalizeTimeZone('Asia/Shanghai\r\nAmerica/New_York'), null, 'no newline smuggling');
assert.equal(normalizeTimeZone('8'), null);

// 3. Offset labels are what makes the dropdown usable: "GMT+8" tells an
// operator more than "Asia/Shanghai" does. Fixed-offset zones keep the test
// independent of the clock and of DST.
assert.equal(timeZoneOffsetLabel('UTC'), 'UTC');
assert.equal(timeZoneOffsetLabel('Asia/Shanghai'), 'GMT+8');
assert.equal(timeZoneOffsetLabel('Asia/Calcutta'), 'GMT+5:30');
assert.equal(timeZoneOffsetLabel('Europe/London') === '' , false, 'a real zone always yields a label');
assert.equal(timeZoneOffsetLabel('Mars/Olympus_Mons'), '', 'unknown zone yields no label');

// 4. The settings page renders a combobox, not the old free-text input: the
// list is embedded with the page so the dropdown and the server agree, the
// input is wired to it, and the popup is the danger-free panel layer.
const page = renderPage();
assert.match(page, /window\.FR_TZ\s*=\s*\{/, 'zone list must ship with the page');
assert.match(page, /window\.FR_TZ\s*=\s*\{"zones":\["UTC"/, 'payload starts at UTC');
assert.match(
  page,
  /<input id="set-timezone"[^>]*role="combobox"[^>]*aria-controls="set-timezone-list"/,
  'timezone input must be a combobox driving the listbox',
);
assert.match(page, /<input id="set-timezone"[^>]*autocomplete="off"/, 'browser autofill would fight the picker');
assert.match(page, /id="set-timezone-list"[^>]*role="listbox"[^>]*hidden/, 'listbox starts closed');
assert.match(page, /\.combo-list\s*\{[^}]*position:\s*absolute/, 'the popup must overlay, not push the layout');
assert.match(page, /\.combo-list\s*\{[^}]*max-height/, 'the popup needs its own scroll for 400 zones');
assert.match(page, /function tzRender\(/, 'the picker must filter as you type');
assert.match(page, /function tzChoose\(/, 'choosing an option must be handled');
assert.match(page, /ArrowDown/, 'keyboard navigation is part of a listbox');
assert.match(page, /aria-activedescendant/, 'the active option must be announced');
assert.match(page, /tz_none/, 'empty result needs a translated message');
// Empty is a legal stored value ("use this machine's dates"), so it must be
// selectable rather than unreachable once the box is a picker.
assert.match(page, /tz_local/, 'the empty "server local time" choice must be reachable');
assert.match(page, /function tzShowCommitted\(/, 'the committed value drives the input, not the filter text');
// The save button must post the committed zone; a half-typed filter is not a
// setting, and the server would reject it anyway.
assert.match(page, /timezone:\s*tzCommitted/, 'save must send the committed zone');
assert.doesNotMatch(page, /timezone:\s*el\('set-timezone'\)\.value/, 'save must not send raw filter text');
// The input must not inherit the row's right-aligned mono style; zone ids read
// left-to-right even in an RTL interface.
assert.match(page, /\.combo input[^}]*direction:\s*ltr/, 'zone ids stay LTR in RTL layouts');

console.log('timezone unit tests passed');
