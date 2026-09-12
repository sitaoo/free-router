import crypto from 'node:crypto';

// Salted scrypt password storage. Format is self-describing so parameters
// can evolve without breaking old hashes:
//   $scrypt$N=<n>$r=<r>$p=<p>$<saltHex>$<keyHex>
const HASH_PREFIX = '$scrypt$';
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 };
// Enough for N=16384/r=8/p=1 (~16 MiB) with headroom; parsed hashes from
// the config file are additionally capped before allocating (see parseHash).
const MAX_MEM = 64 * 1024 * 1024;

export function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith(HASH_PREFIX);
}

function parseHash(stored) {
  const match = String(stored || '').match(
    /^\$scrypt\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/,
  );
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 8) return null;
  const salt = Buffer.from(match[4], 'hex');
  const key = Buffer.from(match[5], 'hex');
  if (!salt.length || salt.length > 64 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

export function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password ?? ''), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });
  return `$scrypt$N=${params.N}$r=${params.r}$p=${params.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function safeEqualBuffers(left, right) {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Verifies against a hash, or against a legacy plaintext value (timing-safe
// either way). Returns false for malformed hashes instead of throwing.
export function verifyPassword(input, stored) {
  const candidate = String(input ?? '');
  if (!isPasswordHash(stored)) {
    return safeEqualBuffers(Buffer.from(candidate), Buffer.from(String(stored ?? '')));
  }
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let derived;
  try {
    derived = crypto.scryptSync(candidate, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM * 2,
    });
  } catch {
    return false;
  }
  return safeEqualBuffers(derived, parsed.key);
}
