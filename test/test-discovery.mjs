#!/usr/bin/env node
// Unit tests for discovery helpers (app/discovery.mjs):
// - a probe that reports a positive cost was not free, whatever the catalog said;
// - which catalog models are still worth a probe request, in batches.
import assert from 'node:assert/strict';

import { probeBatchPlan, probeCandidates, responseLooksBilled } from '../app/discovery.mjs';

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

// ---- probe planning (the add-provider background drain) ------------------
const probeCatalog = new Map(
  [
    ['allowlisted', { id: 'allowlisted', architecture: { output_modalities: ['text'] } }],
    ['selected-paid', { id: 'selected-paid', architecture: { output_modalities: ['text'] } }],
    ['answered', { id: 'answered', architecture: { output_modalities: ['text'] } }],
    ['excluded', { id: 'excluded', architecture: { output_modalities: ['text'] } }],
    ['embed', { id: 'embed', architecture: { output_modalities: ['embedding'] } }],
    ['fresh-a', { id: 'fresh-a', architecture: { output_modalities: ['text'] } }],
    ['fresh-b', { id: 'fresh-b', architecture: { output_modalities: ['text'] } }],
    ['fresh-c', { id: 'fresh-c', architecture: { output_modalities: ['text'] } }],
  ].map(([id, model]) => [id, model]),
);
const probeProvider = {
  name: 'demo',
  probeFreeTier: true,
  catalog: probeCatalog,
  freeModels: new Set(['allowlisted']),
  selectedModels: new Set(['selected-paid']),
};
const probeVerdicts = { 'demo:answered': { free: false } };
const plan = probeBatchPlan({
  provider: probeProvider,
  verdictFor: (key) => probeVerdicts[key] || null,
  isExcluded: (key) => (key === 'demo:excluded' ? 'domain-specific' : ''),
  limit: 2,
});
assert.deepEqual(plan.candidates, ['fresh-a', 'fresh-b']);
assert.equal(plan.remaining, 1);
assert.deepEqual(
  probeCandidates({ provider: probeProvider, verdictFor: () => null, limit: 10 }).sort(),
  ['answered', 'excluded', 'fresh-a', 'fresh-b', 'fresh-c'],
);

// Only probeable providers with a loaded catalog ever produce candidates.
assert.deepEqual(
  probeCandidates({
    provider: { ...probeProvider, probeFreeTier: false },
    limit: 10,
  }),
  [],
);
assert.deepEqual(probeCandidates({ provider: { ...probeProvider, catalog: new Map() }, limit: 10 }), []);
assert.deepEqual(probeBatchPlan({ provider: { ...probeProvider, probeFreeTier: false } }), {
  candidates: [],
  remaining: 0,
});

console.log('discovery unit tests passed');
