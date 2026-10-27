#!/usr/bin/env node
// Unit tests for discovery helpers (app/discovery.mjs):
// - a probe that reports a positive cost was not free, whatever the catalog said;
// - a cached free verdict must put the model back into the route after a
//   state-file loss, without spending another probe.
import assert from 'node:assert/strict';

import { adoptableFreeModels, responseLooksBilled } from '../app/discovery.mjs';

assert.equal(responseLooksBilled({ usage: { cost: 0.0001 } }), true);
assert.equal(responseLooksBilled({ usage: { total_cost: 1 } }), true);
assert.equal(responseLooksBilled({ usage: { credits: 0.5 } }), true);
assert.equal(responseLooksBilled({ usage: { total_credits: 2 } }), true);
assert.equal(responseLooksBilled({ usage: { cost: 0 } }), false);
assert.equal(responseLooksBilled({ usage: { cost: '0' } }), false);
assert.equal(responseLooksBilled({ usage: { prompt_tokens: 10 } }), false);
assert.equal(responseLooksBilled({ usage: null }), false);
assert.equal(responseLooksBilled({}), false);
assert.equal(responseLooksBilled(null), false);

const catalog = new Map([
  ['kept-flash', { id: 'kept-flash', architecture: { output_modalities: ['text'] } }],
  ['paid-flash', { id: 'paid-flash', architecture: { output_modalities: ['text'] } }],
  ['embed-only', { id: 'embed-only', architecture: { output_modalities: ['embedding'] } }],
  ['already', { id: 'already', architecture: { output_modalities: ['text'] } }],
  ['listed', { id: 'listed', architecture: { output_modalities: ['text'] } }],
  ['excluded', { id: 'excluded', architecture: { output_modalities: ['text'] } }],
]);
const provider = { name: 'demo', probeFreeTier: true, catalog };
const verdicts = {
  'demo:kept-flash': { free: true },
  'demo:paid-flash': { free: false },
  'demo:already': { free: true },
  'demo:listed': { free: true },
  'demo:excluded': { free: true },
};
const adopted = adoptableFreeModels({
  providers: [provider],
  discoveredIds: ['demo:already'],
  knownSlugs: new Set(['listed']),
  verdictFor: (key) => verdicts[key] || null,
  isExcluded: (key) => (key === 'demo:excluded' ? 'domain-specific' : ''),
});
assert.deepEqual(adopted, ['demo:kept-flash']);

// Providers without probeFreeTier or without a catalog never contribute.
assert.deepEqual(
  adoptableFreeModels({
    providers: [{ name: 'demo', catalog }, { name: 'other', probeFreeTier: true }],
    discoveredIds: [],
    knownSlugs: new Set(),
    verdictFor: () => ({ free: true }),
    isExcluded: () => '',
  }),
  [],
);

// No verdict is not a free verdict.
assert.deepEqual(
  adoptableFreeModels({
    providers: [provider],
    discoveredIds: [],
    knownSlugs: new Set(),
    verdictFor: () => null,
    isExcluded: () => '',
  }),
  [],
);

console.log('discovery unit tests passed');
