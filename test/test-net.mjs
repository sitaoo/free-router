#!/usr/bin/env node
// Unit tests for LAN address detection (app/net.mjs): external IPv4 only,
// deduplicated, with hostname and container-view flag passed through.
import assert from 'node:assert/strict';

import { describeLanAccess, isLanOpen, lanGuard, loginLockout, recordLoginFailure } from '../app/net.mjs';

const fakeInterfaces = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
  eth0: [
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  wlan0: [
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: '10.0.0.5', family: 'IPv4', internal: false },
  ],
  broken: [null, {}, { address: '', family: 'IPv4', internal: false }],
};

// Only external IPv4, deduplicated, order stable.
{
  const info = describeLanAccess({ interfaces: fakeInterfaces, hostname: 'box', inDocker: false });
  assert.deepEqual(info.addresses, ['192.168.1.20', '10.0.0.5']);
  assert.equal(info.hostname, 'box');
  assert.equal(info.inDocker, false);
}

// Empty input is empty output, not an error.
{
  const info = describeLanAccess({ interfaces: {}, hostname: '', inDocker: true });
  assert.deepEqual(info.addresses, []);
  assert.equal(info.inDocker, true);
}

// Live defaults: returns live interfaces without throwing.
{
  const info = describeLanAccess();
  assert.ok(Array.isArray(info.addresses));
  assert.equal(typeof info.hostname, 'string');
  assert.equal(typeof info.inDocker, 'boolean');
}

// Switch state derives from the bind address: anything that is not an
// explicit loopback bind counts as LAN-open (custom LAN IPs stay ON).
assert.equal(isLanOpen('0.0.0.0'), true);
assert.equal(isLanOpen('192.168.1.10'), true);
assert.equal(isLanOpen('127.0.0.1'), false);
assert.equal(isLanOpen('localhost'), false);
assert.equal(isLanOpen('::1'), false);
assert.equal(isLanOpen(''), false);
assert.equal(isLanOpen(undefined), false);

// Boot guard: loopback binds always pass; a LAN bind needs gateway keys
// and a non-default password, with one reason per missing piece.
assert.deepEqual(lanGuard({ host: '127.0.0.1', keyCount: 0, isDefaultPassword: true }), []);
assert.deepEqual(lanGuard({ host: 'localhost', keyCount: 0, isDefaultPassword: true }), []);
assert.deepEqual(lanGuard({ host: '0.0.0.0', keyCount: 1, isDefaultPassword: false }), []);
assert.deepEqual(lanGuard({ host: '192.168.1.10', keyCount: 2, isDefaultPassword: false }), []);
assert.equal(lanGuard({ host: '0.0.0.0', keyCount: 0, isDefaultPassword: false }).length, 1);
assert.equal(lanGuard({ host: '0.0.0.0', keyCount: 1, isDefaultPassword: true }).length, 1);
assert.equal(lanGuard({ host: '0.0.0.0', keyCount: 0, isDefaultPassword: true }).length, 2);

// Login brute-force: 5 failures lock the IP for 5 minutes; success clears.
{
  const NOW = 1_000_000;
  assert.deepEqual(loginLockout(undefined, NOW), { locked: false });
  let state;
  for (let i = 0; i < 4; i += 1) {
    state = recordLoginFailure(state, NOW);
    assert.deepEqual(loginLockout(state, NOW), { locked: false });
  }
  state = recordLoginFailure(state, NOW);
  const locked = loginLockout(state, NOW);
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfterMs, 5 * 60 * 1000);
  assert.deepEqual(loginLockout(state, NOW + 5 * 60 * 1000 + 1), { locked: false });
}

console.log('net unit tests passed');
