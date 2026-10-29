// In-memory request log: one finished record per client gateway call, kept in
// a ring buffer and exposed newest first for the web UI. Records are built from
// a fixed whitelist so request content, headers, and key values can never end
// up here, and every free-text field is cleaned and capped before storage.

export const REQUEST_LOG_CAPACITY = 500;
export const REQUEST_LOG_MAX_ATTEMPTS = 20;
const MAX_FIELDS = 40;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const OUTCOMES = new Set(['ok', 'empty', 'interrupted', 'aborted', 'blocked', 'failed', 'rejected']);

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function nonNegative(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), MAX_DURATION_MS);
}

function httpStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoOr(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function cleanFields(value) {
  if (!Array.isArray(value)) return [];
  const fields = [];
  for (const entry of value) {
    const name = cleanText(entry, 40);
    if (name) fields.push(name);
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

function cleanAttempts(value) {
  if (!Array.isArray(value)) return [];
  const attempts = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    attempts.push({
      provider: cleanText(entry.provider, 64),
      model: cleanText(entry.model, 200),
      key: cleanText(entry.key, 64),
      status: httpStatus(entry.status),
      ok: entry.ok === true,
      kind: cleanText(entry.kind, 40),
      reason: cleanText(entry.reason, 240),
      ms: nonNegative(entry.ms) ?? 0,
    });
    if (attempts.length >= REQUEST_LOG_MAX_ATTEMPTS) break;
  }
  return attempts;
}

// Whitelist-only copy: unknown input keys are dropped, not filtered later.
export function normalizeRequestRecord(input, { now = Date.now } = {}) {
  const source = isPlainObject(input) ? input : {};
  const at = isoOr(source.at, new Date(now()).toISOString());
  const outcome = OUTCOMES.has(source.outcome) ? source.outcome : 'failed';
  return {
    id: cleanText(source.id, 64),
    at,
    startedAt: isoOr(source.startedAt, at),
    durationMs: nonNegative(source.durationMs) ?? 0,
    dialect: source.dialect === 'responses' ? 'responses' : 'chat',
    stream: source.stream === true,
    model: cleanText(source.model, 200),
    provider: cleanText(source.provider, 64),
    upstreamModel: cleanText(source.upstreamModel, 200),
    key: cleanText(source.key, 64),
    status: httpStatus(source.status),
    outcome,
    reason: cleanText(source.reason, 240),
    firstTokenMs: nonNegative(source.firstTokenMs),
    fields: cleanFields(source.fields),
    attempts: cleanAttempts(source.attempts),
  };
}

export function createRequestLog({ capacity = REQUEST_LOG_CAPACITY, now = Date.now } = {}) {
  const limit = Number.isFinite(capacity)
    ? Math.min(Math.max(Math.trunc(capacity), 1), 5000)
    : REQUEST_LOG_CAPACITY;
  const entries = [];
  const since = new Date(now()).toISOString();
  return {
    capacity: limit,
    since,
    get size() {
      return entries.length;
    },
    add(input) {
      const record = normalizeRequestRecord(input, { now });
      entries.push(record);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return record;
    },
    snapshot() {
      // Newest first; the array is a copy, the records are immutable by
      // convention (only this module writes them).
      return { capacity: limit, size: entries.length, since, entries: entries.slice().reverse() };
    },
  };
}
