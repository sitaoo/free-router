#!/usr/bin/env node
// CORS decision table (app/cors.mjs): off by default, wildcard, exact list,
// reflected origin, and no headers for a non-browser request.
import assert from 'node:assert/strict';

import { corsEnabled, corsHeaders, corsOrigin } from '../app/cors.mjs';

assert.equal(corsEnabled(false), false);
assert.equal(corsEnabled(undefined), false);
assert.equal(corsEnabled([]), false);
assert.equal(corsEnabled(true), true);
assert.equal(corsEnabled(['https://a.example']), true);

assert.equal(corsOrigin(false, 'https://a.example'), '');
assert.equal(corsOrigin(true, ''), '', 'no Origin header, no CORS');
assert.equal(corsOrigin(true, 'https://a.example'), '*');
assert.equal(corsOrigin(['https://a.example'], 'https://a.example'), 'https://a.example');
assert.equal(corsOrigin(['https://a.example'], 'https://b.example'), '');
assert.equal(corsOrigin([' https://a.example '], 'https://a.example'), 'https://a.example');

assert.equal(corsHeaders(false, 'https://a.example'), null);
assert.equal(corsHeaders(true, ''), null);

const wildcard = corsHeaders(true, 'https://a.example');
assert.equal(wildcard['Access-Control-Allow-Origin'], '*');
assert.equal(wildcard['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
assert.match(wildcard['Access-Control-Allow-Headers'], /Authorization/);
assert.match(wildcard['Access-Control-Allow-Headers'], /Content-Type/);
assert.match(wildcard['Access-Control-Expose-Headers'], /X-Free-Router-Request-Id/);
assert.equal('Vary' in wildcard, false, 'a wildcard must not vary by origin');

const reflected = corsHeaders(['https://a.example'], 'https://a.example');
assert.equal(reflected['Access-Control-Allow-Origin'], 'https://a.example');
assert.equal(reflected.Vary, 'Origin');

console.log('cors unit tests passed');
