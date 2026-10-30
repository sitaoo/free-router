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
  // null/undefined/"" mean "no sample", not zero: Number(null) is 0, which
  // would otherwise turn an absent first-token time into a plausible 0 ms.
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), MAX_DURATION_MS);
}

const MAX_COUNT = 1_000_000_000;

// Counts describe an answer (characters, tool calls) without storing it.
function count(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), MAX_COUNT);
}

// Tokens per second over the time the model actually spent generating: from
// its first token to the end of the answer. A non-stream (JSON) answer has no
// first-token sample, so the whole request is used instead — that is a floor,
// since it also counts the wait for the upstream, not an inflated number.
export function outputTokensPerSecond({ outputTokens, durationMs, firstTokenMs }) {
  const tokens = count(outputTokens);
  const total = nonNegative(durationMs);
  if (!tokens || total === null || total <= 0) return null;
  const first = nonNegative(firstTokenMs);
  const generationMs = first !== null && first > 0 && first < total ? total - first : total;
  if (generationMs <= 0) return null;
  return Math.round((tokens / generationMs) * 10000) / 10;
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
  const durationMs = nonNegative(source.durationMs) ?? 0;
  const firstTokenMs = nonNegative(source.firstTokenMs);
  const inputTokens = count(source.inputTokens);
  const outputTokens = count(source.outputTokens);
  return {
    id: cleanText(source.id, 64),
    at,
    startedAt: isoOr(source.startedAt, at),
    durationMs,
    dialect: source.dialect === 'responses' ? 'responses' : 'chat',
    stream: source.stream === true,
    model: cleanText(source.model, 200),
    provider: cleanText(source.provider, 64),
    upstreamModel: cleanText(source.upstreamModel, 200),
    key: cleanText(source.key, 64),
    status: httpStatus(source.status),
    outcome,
    reason: cleanText(source.reason, 240),
    firstTokenMs,
    finishReason: cleanText(source.finishReason, 40),
    toolCalls: count(source.toolCalls),
    contentChars: count(source.contentChars),
    reasoningChars: count(source.reasoningChars),
    inputTokens,
    outputTokens,
    outputTps: outputTokensPerSecond({ outputTokens, durationMs, firstTokenMs }),
    fields: cleanFields(source.fields),
    attempts: cleanAttempts(source.attempts),
  };
}

// Rebuilds records from a persisted JSONL file: torn lines (a hard kill
// mid-write) are skipped and only the newest `limit` survive.
export function parseRequestLogLines(text, { limit = REQUEST_LOG_CAPACITY } = {}) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // Ignore: the last line of a killed process is often incomplete.
    }
  }
  const keep = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : REQUEST_LOG_CAPACITY;
  return records.slice(-keep);
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
    clear() {
      // `since` stays: it marks when the process started keeping records.
      const removed = entries.length;
      entries.length = 0;
      return removed;
    },
  };
}
