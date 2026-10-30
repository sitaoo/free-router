// Gateway (downstream) client-key policy: optional expiry and a per-day
// request quota, plus the small usage map that enforces it. Pure functions so
// the rules are unit-testable without booting the server.

const DAY_MS = 86400000;
const MAX_DAILY_LIMIT = 1000000;

// '' / undefined / null mean "no limit" (0). Anything that is not a
// non-negative integer below the cap is rejected with null, so the caller can
// answer 400 instead of silently storing a limit nobody meant.
export function parseDailyLimit(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > MAX_DAILY_LIMIT) return null;
  return number;
}

// Accepts a bare date (meaning "valid through the end of that day, UTC") or a
// full timestamp. '' means no expiry; an unparseable value returns null.
export function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  if (!text) return '';
  const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) {
    const end = Date.parse(`${text}T23:59:59.999Z`);
    return Number.isFinite(end) ? new Date(end).toISOString() : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// Milliseconds until the next midnight in the configured zone. Derived from
// the zone's wall-clock time of day, so it needs no offset arithmetic and
// stays right across DST changes.
export function msUntilNextDay(now = Date.now(), timeZone = 'UTC') {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
  } catch {
    return msUntilNextDay(now, 'UTC');
  }
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const seconds = pick('hour') * 3600 + pick('minute') * 60 + pick('second');
  return Math.max(1000, DAY_MS - seconds * 1000 - (now % 1000));
}

// What this key may do right now. `used` is today's request count for the key.
export function gatewayKeyState(entry, { now = Date.now(), used = 0, timeZone = 'UTC' } = {}) {
  const expiresAt = Date.parse(entry?.expiresAt || '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return {
      ok: false,
      status: 401,
      reason: 'expired',
      message: `API key expired at ${new Date(expiresAt).toISOString()}`,
      remaining: null,
    };
  }
  const limit = Math.floor(Number(entry?.dailyLimit));
  if (Number.isFinite(limit) && limit > 0) {
    const remaining = Math.max(0, limit - used);
    if (remaining === 0) {
      return {
        ok: false,
        status: 429,
        reason: 'quota',
        message: `daily request limit reached (${limit}/day)`,
        retryAfterMs: msUntilNextDay(now, timeZone),
        remaining: 0,
      };
    }
    return { ok: true, status: 200, reason: '', message: '', remaining };
  }
  return { ok: true, status: 200, reason: '', message: '', remaining: null };
}

export function gatewayUsageFor(usage, name, day) {
  const count = Number(usage?.[name]?.[day]);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// Keeps only the newest `maxDays` days (counting back from `day`) and drops
// anything that is not a positive integer count.
function pruneKeyDays(days, day, maxDays) {
  const keep = new Set();
  const anchor = Date.parse(`${day}T00:00:00Z`);
  for (let offset = 0; offset < Math.max(1, maxDays); offset += 1) {
    keep.add(new Date(anchor - offset * DAY_MS).toISOString().slice(0, 10));
  }
  for (const key of Object.keys(days)) {
    if (!keep.has(key)) delete days[key];
  }
}

export function recordGatewayUse(usage, name, day, maxDays = 3) {
  if (!usage || typeof usage !== 'object' || !name) return usage;
  const perKey = (usage[name] ||= {});
  perKey[day] = gatewayUsageFor(usage, name, day) + 1;
  pruneKeyDays(perKey, day, maxDays);
  return usage;
}

// Rebuilds the persisted usage map from disk: unknown names, bad day keys and
// non-positive counts are dropped so a hand-edited state file cannot inflate
// a quota or grow the map without bound.
export function sanitizeGatewayUsage(raw, days) {
  const allowed = new Set(Array.isArray(days) ? days : []);
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [name, perDay] of Object.entries(raw)) {
    if (!name || name.length > 64 || !perDay || typeof perDay !== 'object') continue;
    const bucket = {};
    for (const [day, count] of Object.entries(perDay)) {
      if (!allowed.has(day)) continue;
      const value = Math.floor(Number(count));
      if (Number.isFinite(value) && value > 0) bucket[day] = value;
    }
    if (Object.keys(bucket).length) clean[name] = bucket;
  }
  return clean;
}
