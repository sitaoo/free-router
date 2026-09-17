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

// Binds-everywhere check shared by the UI switch state: anything that is not
// an explicit loopback bind counts as LAN-open.
export function isLanOpen(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  return value !== '127.0.0.1' && value !== 'localhost' && value !== '::1';
}
