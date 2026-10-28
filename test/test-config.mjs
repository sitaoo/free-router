#!/usr/bin/env node
// Unit tests for schema v2 of the config overlay (app/config.mjs): routes are
// gone, discovery no longer names a provider or route, and existing operator
// values (including their absent-ness) survive the migration.
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  addMissingKeys,
  buildLiveConfig,
  defaultConfigObject,
  runOverlayMigrations,
} from '../app/config.mjs';

assert.equal(SCHEMA_VERSION, 2);

// ---- shipped defaults -----------------------------------------------------
const defaults = defaultConfigObject();
assert.equal(defaults.routes, undefined);
assert.equal(defaults.discovery.route, undefined);
assert.equal(defaults.discovery.provider, undefined);
assert.equal(defaults.discovery.evaluation.probeBatchSize, 3);
assert.equal(defaults.discovery.evaluation.probeBatchDelayMs, 2000);
assert.equal(defaults.discovery.evaluation.probeMaxPerProvider, 100);
assert.equal(defaults.cooldownMs.insufficientFunds, 86400000);

// ---- v2 migration ---------------------------------------------------------
const overlay = {
  _schemaVersion: 1,
  routes: { 'free-best': [{ provider: 'gemini', model: 'gemini-3.8-flash' }] },
  _removedRoutes: ['custom'],
  discovery: {
    intervalMs: 3600000,
    route: 'free-best',
    provider: 'openrouter',
    evaluation: { enabled: false, probeBatchSize: 9 },
  },
  providers: { gemini: { freeModels: ['gemini-3.8-flash'] } },
};
const changed = runOverlayMigrations(overlay);
assert.equal(changed, true);
assert.equal(overlay._schemaVersion, 2);
assert.equal('routes' in overlay, false);
assert.equal('_removedRoutes' in overlay, false);
assert.equal('route' in overlay.discovery, false);
assert.equal('provider' in overlay.discovery, false);
// Operator values win; only the missing probe knobs are added.
assert.equal(overlay.discovery.evaluation.probeBatchSize, 9);
assert.equal(overlay.discovery.evaluation.probeBatchDelayMs, 2000);
assert.equal(overlay.discovery.evaluation.probeMaxPerProvider, 100);
assert.equal(overlay.discovery.evaluation.enabled, false);
assert.equal(overlay.discovery.intervalMs, 3600000);
assert.deepEqual(overlay.providers.gemini.freeModels, ['gemini-3.8-flash']);

// Running again changes nothing.
assert.equal(runOverlayMigrations(overlay), false);

// An overlay with no discovery section is not given one.
const bare = { _schemaVersion: 1, routes: {} };
assert.equal(runOverlayMigrations(bare), true);
assert.equal('discovery' in bare, false);
assert.equal('routes' in bare, false);

// ---- live config ----------------------------------------------------------
const live = buildLiveConfig(
  { providers: { a: {}, b: {} }, routes: { 'free-best': [] } },
  { providers: { a: { baseUrl: 'http://x' } }, _removedProviders: ['b'], _removedRoutes: ['free-best'] },
);
assert.deepEqual(Object.keys(live.providers), ['a']);
// The route tombstone is no longer honoured, and no code reads routes anyway.
assert.deepEqual(live.routes, { 'free-best': [] });

// addMissingKeys keeps the additive contract.
const target = { a: 1, nested: { keep: true } };
assert.equal(addMissingKeys(target, { a: 2, b: 3, nested: { keep: false, add: 4 } }), true);
assert.deepEqual(target, { a: 1, b: 3, nested: { keep: true, add: 4 } });

console.log('config unit tests passed');
