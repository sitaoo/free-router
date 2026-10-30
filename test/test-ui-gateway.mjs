#!/usr/bin/env node
// Access tab gateway keys: each row can copy the full key value to the
// clipboard (the table still shows the masked form), using the same
// textarea fallback the Logs tab uses for plain-HTTP origins.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

assert.match(page, /t\('gw_copy'\)/, 'the copy button needs a translated label');
assert.match(page, /copyLogText\(entry\.key\)/, 'the copy button copies the full key value');
assert.match(page, /actions\.append\(copy, edit, del\)/, 'copy sits with the other row actions');
assert.match(page, /td\(entry\.masked, 'mono'\)/, 'the cell keeps showing the masked key');

const start = page.indexOf('function renderGateway(');
const end = page.indexOf('function isLanOpen(', start);
assert.ok(start >= 0 && end > start, 'renderGateway block not found');
const block = page.slice(start, end);
assert.equal(block.includes('`'), false, 'no template literals in the inline script');
assert.equal(block.includes('${'), false, 'no template interpolation in the inline script');
assert.equal(block.includes('innerHTML'), false, 'render with textContent only');

console.log('gateway UI tests passed');
