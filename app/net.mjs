import fs from 'node:fs';
import os from 'node:os';

// LAN reachability facts for the "allow LAN access" switch: which addresses
// this machine answers on, its hostname, and whether we see a container view
// (Docker bridge NAT hides the host LAN IP, so callers must say so).
// Pure inputs keep this unit-testable; server.mjs passes the live values.
export function describeLanAccess({
  interfaces = os.networkInterfaces(),
  hostname = os.hostname(),
  inDocker = (() => {
    try {
      return fs.existsSync('/.dockerenv');
    } catch {
      return false;
    }
  })(),
} = {}) {
  const addresses = [];
  for (const addrs of Object.values(interfaces || {})) {
    for (const addr of addrs || []) {
      if (!addr || addr.internal || addr.family !== 'IPv4' || !addr.address) continue;
      if (!addresses.includes(addr.address)) addresses.push(addr.address);
    }
  }
  return { addresses, hostname: String(hostname || ''), inDocker: Boolean(inDocker) };
}

// Host-header allowlist for the UI guard. Loopback, private LAN addresses and
// local hostnames are always accepted; an operator behind a reverse proxy adds
// the public hostname (exact, `.suffix`, or `*.suffix`) to `trustedHosts`.
export function isLocalHostname(hostname, trustedHosts = []) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '127.0.0.1' || host.startsWith('127.') || host === '[::1]') return true;
  if (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host)) return true;
  if (/^(fc[0-9a-f]{2}|fd[0-9a-f]{2}|fe80):/i.test(host)) return true;
  if (!host.includes('.') && /^[a-z0-9-]+$/i.test(host)) return true;
  for (const entry of Array.isArray(trustedHosts) ? trustedHosts : []) {
    const trusted = String(entry || '').toLowerCase().trim();
    if (!trusted) continue;
    if (trusted.startsWith('*.')) {
      const suffix = trusted.slice(1);
      if (host === trusted.slice(2) || host.endsWith(suffix)) return true;
      continue;
    }
    if (trusted.startsWith('.')) {
      if (host === trusted.slice(1) || host.endsWith(trusted)) return true;
      continue;
    }
    if (host === trusted) return true;
  }
  return false;
}

// Binds-everywhere check shared by the UI switch state: anything that is not
// an explicit loopback bind counts as LAN-open.
export function isLanOpen(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  return value !== '127.0.0.1' && value !== 'localhost' && value !== '::1';
}

// Boot guard for network exposure: a non-loopback bind without gateway keys
// or with the default password would start open to the LAN. Returns one
// reason per missing piece; empty means safe to start.
export function lanGuard({ host, keyCount, isDefaultPassword }) {
  const reasons = [];
  if (!isLanOpen(host)) return reasons;
  if (!(Number(keyCount) > 0)) reasons.push('no gateway keys: /v1 would be open to the LAN');
  if (isDefaultPassword) reasons.push('default web UI password is still set');
  return reasons;
}

// Login brute-force brake: 5 failures lock the IP for 5 minutes. States are
// plain { fails, lockedUntil } objects kept in a caller-owned Map.
export const LOGIN_RATE = { maxFails: 5, lockMs: 5 * 60 * 1000 };

export function loginLockout(state, now = Date.now()) {
  if (state?.lockedUntil && now < state.lockedUntil) {
    return { locked: true, retryAfterMs: state.lockedUntil - now };
  }
  return { locked: false };
}

export function recordLoginFailure(state, now = Date.now()) {
  const fails = (state?.fails || 0) + 1;
  if (fails >= LOGIN_RATE.maxFails) {
    return { fails: 0, lockedUntil: now + LOGIN_RATE.lockMs };
  }
  return { fails, lockedUntil: 0 };
}
