#!/usr/bin/env node
// Key rotation hygiene: a retired (401) key leaves the rotation, and once
// every configured key is retired the provider offers no slots at all. The
// old fallback handed the invalid keys back, so every request retried a
// credential the provider had already refused.
import assert from 'node:assert/strict';

import { createProviderRegistry } from '../app/providers.mjs';

function registryWith(keys) {
  return createProviderRegistry(
    {
      defaultProvider: 'demo',
      providers: {
        demo: {
          baseUrl: 'http://127.0.0.1:9',
          keys,
        },
      },
    },
    { host: '127.0.0.1', port: 9 },
  );
}

{
  const registry = registryWith([
    { name: 'a', key: 'key-a' },
    { name: 'b', key: 'key-b' },
  ]);
  assert.equal(registry.keyCount('demo'), 2);
  assert.equal(registry.keySlots('demo').length, 2);

  registry.markKeyInvalid('demo', 'key-a');
  assert.deepEqual(
    registry.keySlots('demo').map((slot) => slot.key),
    ['key-b'],
    'a retired key leaves the rotation',
  );
  assert.equal(registry.keyCount('demo'), 2, 'configured keys still count');

  registry.markKeyInvalid('demo', 'key-b');
  assert.deepEqual(
    registry.keySlots('demo'),
    [],
    'no slots once every configured key is retired',
  );
}

// A provider with no configured keys (a local endpoint) has no slots either;
// keyCount tells the two cases apart.
{
  const registry = registryWith([]);
  assert.deepEqual(registry.keySlots('demo'), []);
  assert.equal(registry.keyCount('demo'), 0);
}

console.log('provider registry unit tests passed');
